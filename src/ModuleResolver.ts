import { execSync } from "child_process"
import { TextDocument, Uri, window } from "coc.nvim"
import * as findUp from "find-up"
import * as fs from "fs"
import * as path from "path"
import * as prettier from "prettier"
import * as resolve from "resolve"
import * as semver from "semver"
import { resolveGlobalNodePath, resolveGlobalYarnPath } from "./Files"
import { LoggingService } from "./LoggingService"
import {
  FAILED_TO_LOAD_MODULE_MESSAGE,
  INVALID_PRETTIER_CONFIG,
  INVALID_PRETTIER_PATH_MESSAGE,
  OUTDATED_PRETTIER_VERSION_MESSAGE,
  USING_BUNDLED_PRETTIER
} from "./message"
import {
  ModuleResolverInterface,
  PackageManagers,
  PrettierOptions,
  PrettierResolveConfigOptions,
  PrettierVSCodeConfig
} from "./types"
import { getConfig, getWorkspaceRelativePath } from "./util"

const minPrettierVersion = "1.13.0"

export type PrettierNodeModule = typeof prettier

const globalPaths: {
  [key: string]: { cache: string | undefined; get(): string | undefined }
} = {
  npm: {
    cache: undefined,
    get(): string | undefined {
      return resolveGlobalNodePath()
    },
  },
  pnpm: {
    cache: undefined,
    get(): string {
      const pnpmPath = execSync("pnpm root -g").toString().trim()
      return pnpmPath
    },
  },
  yarn: {
    cache: undefined,
    get(): string | undefined {
      return resolveGlobalYarnPath()
    },
  },
}

function globalPathGet(packageManager: PackageManagers): string | undefined {
  const pm = globalPaths[packageManager]
  if (pm) {
    if (pm.cache === undefined) {
      pm.cache = pm.get()
    }
    return pm.cache
  }
  return undefined
}

export class ModuleResolver implements ModuleResolverInterface {
  private findPkgCache: Map<string, string>
  private path2Module = new Map<string, PrettierNodeModule>();

  constructor(private loggingService: LoggingService) {
    this.findPkgCache = new Map()
  }

  public getGlobalPrettierInstance(): PrettierNodeModule {
    return prettier
  }

  /**
   * Returns an instance of the prettier module.
   * @param fileName The path of the file to use as the starting point. If none provided, the bundled prettier will be used.
   */
  public async getPrettierInstance(
    fileName: string
  ): Promise<PrettierNodeModule | undefined> {

    const { prettierPath, resolveGlobalModules, onlyUseLocalVersion } = getConfig(
      Uri.file(fileName)
    )

    // Look for local module
    let modulePath: string | undefined = undefined

    try {
      modulePath = prettierPath
        ? getWorkspaceRelativePath(fileName, prettierPath)
        : this.findPkg(fileName, "prettier")
    } catch (error) {
      let moduleDirectory = ""
      if (!modulePath && error instanceof Error) {
        // If findPkg threw an error from `resolve.sync`, attempt to parse the
        // directory it failed on to provide a better error message
        const resolveSyncPathRegex = /Cannot find module '.*' from '(.*)'/
        const resolveErrorMatches = resolveSyncPathRegex.exec(error.message)
        if (resolveErrorMatches && resolveErrorMatches[1]) {
          moduleDirectory = resolveErrorMatches[1]
        }
      }

      this.loggingService.logInfo(
        `Attempted to determine module path from ${modulePath || moduleDirectory || "package.json"
        }`
      )
      this.loggingService.logError(FAILED_TO_LOAD_MODULE_MESSAGE, error)

      // Return here because there is a local module, but we can't resolve it.
      // Must do NPM install for prettier to work.
      return undefined
    }

    // If global modules allowed, look for global module
    if (resolveGlobalModules && !modulePath) {
      let items: PackageManagers[] = ['npm', 'pnpm', 'yarn']
      const idx = await window.showMenuPicker(items, { title: 'Choose package manager' })
      if (idx !== -1) {
        const packageManager = items[idx]
        const resolvedGlobalPackageManagerPath = globalPathGet(packageManager)
        if (resolvedGlobalPackageManagerPath) {
          const globalModulePath = path.join(
            resolvedGlobalPackageManagerPath,
            "prettier"
          )
          if (fs.existsSync(globalModulePath)) {
            modulePath = globalModulePath
          }
        }
      }
    }

    let moduleInstance: PrettierNodeModule | undefined = undefined
    if (modulePath !== undefined) {
      // First check module cache
      moduleInstance = this.path2Module.get(modulePath)
      if (moduleInstance) {
        this.loggingService.logDebug(
          `Local prettier module path: '${modulePath}'`
        )
        return moduleInstance
      } else {
        try {
          moduleInstance = this.loadNodeModule<PrettierNodeModule>(modulePath)
          if (moduleInstance) {
            this.path2Module.set(modulePath, moduleInstance)
          }
        } catch (error) {
          this.loggingService.logInfo(
            `Attempted to load Prettier module from ${modulePath || "package.json"
            }`
          )
          this.loggingService.logError(FAILED_TO_LOAD_MODULE_MESSAGE, error)

          // Returning here because module didn't load.
          return undefined
        }
      }
    }

    if (moduleInstance) {
      // If the instance is missing `format`, it's probably
      // not an instance of Prettier
      const isPrettierInstance = !!moduleInstance.format
      const isValidVersion =
        moduleInstance.version &&
        !!moduleInstance.getSupportInfo &&
        !!moduleInstance.getFileInfo &&
        !!moduleInstance.resolveConfig &&
        semver.gte(moduleInstance.version, minPrettierVersion)

      if (!isPrettierInstance && prettierPath) {
        this.loggingService.logError(INVALID_PRETTIER_PATH_MESSAGE)
        return undefined
      }

      if (!isValidVersion) {
        this.loggingService.logInfo(
          `Attempted to load Prettier module from ${modulePath}`
        )
        this.loggingService.logError(OUTDATED_PRETTIER_VERSION_MESSAGE)
        return undefined
      }
      return moduleInstance
    } else {
      if (onlyUseLocalVersion) {
        this.loggingService.logInfo('Ignored bundled prettier by onlyUseLocalVersion configuration.')
        return undefined
      }
      this.loggingService.logDebug(USING_BUNDLED_PRETTIER)
      return prettier
    }
  }

  public async getResolvedConfig(
    textDocument: TextDocument,
    vscodeConfig: PrettierVSCodeConfig
  ): Promise<"error" | "disabled" | PrettierOptions | null> {
    const uri = Uri.parse(textDocument.uri)
    const fileName = uri.fsPath
    const isVirtual = uri.scheme !== "file"

    let configPath: string | undefined
    try {
      if (!isVirtual) {
        configPath = (await prettier.resolveConfigFile(fileName)) ?? undefined
      }
    } catch (error) {
      this.loggingService.logError(
        `Error resolving prettier configuration for ${fileName}`,
        error
      )

      return "error"
    }

    const resolveConfigOptions: PrettierResolveConfigOptions = {
      config: isVirtual
        ? undefined
        : vscodeConfig.configPath
          ? getWorkspaceRelativePath(fileName, vscodeConfig.configPath)
          : configPath,
      editorconfig: isVirtual ? undefined : vscodeConfig.useEditorConfig,
    }

    let resolvedConfig: PrettierOptions | null
    try {
      resolvedConfig = isVirtual
        ? null
        : await prettier.resolveConfig(fileName, resolveConfigOptions)
    } catch (error) {
      this.loggingService.logError(
        "Invalid prettier configuration file detected.",
        error
      )
      this.loggingService.logError(INVALID_PRETTIER_CONFIG)

      return "error"
    }
    if (resolveConfigOptions.config) {
      this.loggingService.logInfo(
        `Using config file at '${resolveConfigOptions.config}'`
      )
    }

    if (!isVirtual && !resolvedConfig && vscodeConfig.requireConfig) {
      this.loggingService.logInfo(
        "Require config set to true and no config present. Skipping file."
      )
      return "disabled"
    }
    return resolvedConfig
  }

  /**
   * Clears the module and config cache
   */
  public async dispose() {
    prettier.clearConfigCache()
    this.path2Module.forEach((module) => {
      try {
        module.clearConfigCache()
      } catch (error) {
        this.loggingService.logError("Error clearing module cache.", error)
      }
    })
    this.path2Module.clear()
  }

  // Source: https://github.com/microsoft/vscode-eslint/blob/master/server/src/eslintServer.ts
  private loadNodeModule<T>(moduleName: string): T | undefined {
    try {
      return require(moduleName)
    } catch (error) {
      this.loggingService.logError(
        `Error loading node module '${moduleName}'`,
        error
      )
    }
    return undefined
  }

  private isInternalTestRoot(dir: string): boolean {
    if (process.env.NODE_ENV !== "production") {
      // This is for testing purposes only. This code is removed in the
      // shipped version of this extension so do not use this in your
      // project. It won't work.
      return fs.existsSync(path.join(dir, ".do-not-use-prettier-vscode-root"))
    } else {
      return false
    }
  }

  /**
   * Recursively search upwards for a given module definition based on
   * package.json or node_modules existence
   * @param {string} fsPath file system path to start searching from
   * @param {string} pkgName package's name to search for
   * @returns {string} resolved path to module
   */
  private findPkg(fsPath: string, pkgName: string): string | undefined {
    const cacheKey = `${fsPath}:${pkgName}`
    const packagePathState = this.findPkgCache.get(cacheKey)
    if (packagePathState) {
      return packagePathState
    }

    // Only look for a module definition outside of any `node_modules` directories
    const splitPath = fsPath.split("/")
    let finalPath = fsPath
    const nodeModulesIndex = splitPath.indexOf("node_modules")

    if (nodeModulesIndex > 1) {
      finalPath = splitPath.slice(0, nodeModulesIndex).join("/")
    }

    // First look for an explicit package.json dep
    const packageJsonResDir = findUp.sync(
      (dir) => {
        if (fs.existsSync(path.join(dir, "package.json"))) {
          let packageJson
          try {
            packageJson = JSON.parse(
              fs.readFileSync(path.join(dir, "package.json"), "utf8")
            )
          } catch (e) {
            // Swallow, if we can't read it we don't want to resolve based on it
          }

          if (
            packageJson &&
            ((packageJson.dependencies && packageJson.dependencies[pkgName]) ||
              (packageJson.devDependencies &&
                packageJson.devDependencies[pkgName]))
          ) {
            return dir
          }
        }

        if (this.isInternalTestRoot(dir)) {
          return findUp.stop
        }
      },
      { cwd: finalPath, type: "directory" }
    )

    if (packageJsonResDir) {
      const packagePath = resolve.sync(pkgName, { basedir: packageJsonResDir })
      this.findPkgCache.set(cacheKey, packagePath)
      return packagePath
    }

    // If no explicit package.json dep found, instead look for implicit dep
    const nodeModulesResDir = findUp.sync(
      (dir) => {
        if (fs.existsSync(path.join(dir, "node_modules", pkgName))) {
          return dir
        }

        if (this.isInternalTestRoot(dir)) {
          return findUp.stop
        }
      },
      { cwd: finalPath, type: "directory" }
    )

    if (nodeModulesResDir) {
      const packagePath = resolve.sync(pkgName, { basedir: nodeModulesResDir })
      this.findPkgCache.set(cacheKey, packagePath)
      return packagePath
    }

    return
  }
}
