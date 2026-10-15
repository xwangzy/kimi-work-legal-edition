/** source-scan.mjs 的类型声明（测试以 TypeScript 引用）。 */
export declare const PLATFORM_ROOT: string;
export declare const FS_WRITE_APIS: readonly string[];
export declare function stripComments(src: string): string;
export declare function balancedArgs(text: string, open: number): string | null;
export declare function productionSources(o?: { outOfScope?: string[] }): { rel: string; raw: string; text: string }[];
export declare function fsWriteCalls(text: string): string[];
