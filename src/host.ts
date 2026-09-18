/**
 * 宿主 eda 全局与通用工具。全程 duck-typing，隔离 @beta API 变更。
 */

export function edaGlobal(): Record<string, unknown> | undefined {
	return typeof eda !== 'undefined' ? (eda as unknown as Record<string, unknown> | undefined) : undefined;
}

/** 宿主 API 可能抛普通对象而非 Error。 */
export function fmtErr(e: unknown): string {
	if (e instanceof Error)
		return e.message;
	try {
		const s = JSON.stringify(e);
		if (s && s !== '{}')
			return s.slice(0, 300);
	}
	catch { /* 循环引用等 */ }
	return String(e);
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, rej) => setTimeout(() => rej(new Error(message)), ms)),
	]);
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
