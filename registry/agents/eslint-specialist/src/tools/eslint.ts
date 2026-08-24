import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

export interface EslintViolation {
    filePath: string
    line: number
    column: number
    severity: 1 | 2
    ruleId: string | null
    message: string
}

export interface EslintFileResult {
    filePath: string
    violations: EslintViolation[]
    errorCount: number
    warningCount: number
    fixableErrorCount: number
    fixableWarningCount: number
}

export interface EslintResult {
    files: EslintFileResult[]
    totalErrors: number
    totalWarnings: number
    totalFixable: number
}

export interface ProjectShape {
    hasTypeScript: boolean
    hasVue: boolean
    hasReact: boolean
    isMonorepo: boolean
    isLibrary: boolean
    eslintConfigPath: string | null
}

export const eslint = {
    /**
     * Run ESLint on a path and return structured results.
     * Pass fix: true to apply auto-fixes in place — ESLint rewrites the files directly.
     * Use quiet: true to suppress warnings and return errors only (useful in CI).
     */
    async run(targetPath: string, options: { fix?: boolean; quiet?: boolean } = {}): Promise<EslintResult> {
        const flags = [
            options.fix ? "--fix" : "",
            options.quiet ? "--quiet" : "",
            "--format json",
        ].filter(Boolean).join(" ")

        const cmd = `npx eslint ${flags} "${targetPath}" 2>/dev/null || true`

        let raw: string
        try {
            raw = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
        } catch (err: any) {
            // ESLint exits non-zero when violations exist; stdout still contains valid JSON
            raw = err.stdout ?? "[]"
        }

        let parsed: any[]
        try {
            parsed = JSON.parse(raw)
        } catch {
            return { files: [], totalErrors: 0, totalWarnings: 0, totalFixable: 0 }
        }

        const files: EslintFileResult[] = parsed.map((f: any) => ({
            filePath: f.filePath,
            violations: (f.messages ?? []).map((m: any) => ({
                filePath: f.filePath,
                line: m.line,
                column: m.column,
                severity: m.severity,
                ruleId: m.ruleId ?? null,
                message: m.message,
            })),
            errorCount: f.errorCount ?? 0,
            warningCount: f.warningCount ?? 0,
            fixableErrorCount: f.fixableErrorCount ?? 0,
            fixableWarningCount: f.fixableWarningCount ?? 0,
        }))

        return {
            files,
            totalErrors: files.reduce((n, f) => n + f.errorCount, 0),
            totalWarnings: files.reduce((n, f) => n + f.warningCount, 0),
            totalFixable: files.reduce((n, f) => n + f.fixableErrorCount + f.fixableWarningCount, 0),
        }
    },

    /**
     * Count violations per rule across a path.
     * Returns a map of ruleId → total violation count across all files.
     * Used by setup and sensor to compute the error signal.
     */
    async counts(targetPath: string): Promise<Record<string, number>> {
        const result = await eslint.run(targetPath)
        const counts: Record<string, number> = {}
        for (const file of result.files) {
            for (const v of file.violations) {
                if (!v.ruleId) continue
                counts[v.ruleId] = (counts[v.ruleId] ?? 0) + 1
            }
        }
        return counts
    },

    /**
     * Detect the project shape from the working directory.
     * Used by setup to select the appropriate setpoint profile and record
     * context that informs all future audit and fix operations.
     */
    detectShape(cwd: string = process.cwd()): ProjectShape {
        const has = (file: string) => fs.existsSync(path.join(cwd, file))
        const readJson = (file: string) => {
            try { return JSON.parse(fs.readFileSync(path.join(cwd, file), "utf-8")) } catch { return null }
        }

        const pkg = readJson("package.json")

        const eslintConfigs = [
            "eslint.config.mjs", "eslint.config.js", "eslint.config.ts",
            ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml",
        ]
        const eslintConfigFile = eslintConfigs.find(f => has(f))

        return {
            hasTypeScript: has("tsconfig.json") || has("tsconfig.base.json"),
            hasVue: !!(pkg?.dependencies?.vue || pkg?.devDependencies?.vue),
            hasReact: !!(pkg?.dependencies?.react || pkg?.devDependencies?.react),
            isMonorepo: has("pnpm-workspace.yaml") || (has("bun.lockb") && has("packages")),
            isLibrary: !!(pkg?.main || pkg?.exports) && !pkg?.private,
            eslintConfigPath: eslintConfigFile ? path.join(cwd, eslintConfigFile) : null,
        }
    },

    config: {
        /**
         * Read the ESLint config file at the given path and return its source as a string.
         * Pass this to the agent when proposing or applying tighten changes.
         */
        read(configPath: string): string {
            return fs.readFileSync(configPath, "utf-8")
        },

        /**
         * Write a new ESLint config to disk, replacing the existing file.
         * Only call this after the engineer has approved the proposed diff.
         * The tighten script handles the approval gate — do not call this directly.
         */
        write(configPath: string, content: string): void {
            fs.writeFileSync(configPath, content, "utf-8")
        },
    },
}
