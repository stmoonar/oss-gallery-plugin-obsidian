/**
 * 错误处理工具类，提供统一的错误处理机制
 */

/**
 * 错误级别枚举
 */
export enum ErrorLevel {
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error'
}

/**
 * 错误上下文信息
 */
export interface ErrorContext {
    operation: string;
    filename?: string;
    additionalInfo?: Record<string, unknown>;
}

/**
 * 敏感键名 + 其后的值（key=value / key: value / "key": "value"）
 */
const SENSITIVE_KEY_VALUE_PATTERN =
    /((?:access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access)?[_-]?key|password|passwd|pwd|token|authorization|credential|signature|secret)[\w-]*"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^&\s,;"']+)/gi;

/**
 * 过滤敏感信息
 * @param message 原始消息
 * @returns 过滤后的消息
 */
export function filterSensitiveInfo(message: string): string {
    let filtered = message;

    // key=value / key: value 形式的凭据
    filtered = filtered.replace(SENSITIVE_KEY_VALUE_PATTERN, '$1[REDACTED]');

    // Authorization: Bearer/Basic xxx 形式
    filtered = filtered.replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [REDACTED]');

    // URL 查询参数：预签名 URL 的签名/凭据都在参数值里，全部脱敏
    filtered = filtered.replace(/([?&][^=&\s?#]+)=[^&\s#]*/g, '$1=[REDACTED]');

    return filtered;
}

/**
 * 处理并记录错误
 * @param error 错误对象
 * @param context 错误上下文
 * @param level 错误级别
 */
export function handleError(
    error: unknown,
    context: string | ErrorContext,
    level: ErrorLevel = ErrorLevel.ERROR
): void {
    const errorContext = typeof context === 'string'
        ? { operation: context }
        : context;

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // 构建安全的错误消息
    const safeMessage = filterSensitiveInfo(errorMessage);
    const safeContext = {
        ...errorContext,
        additionalInfo: errorContext.additionalInfo
            ? filterSensitiveInfo(JSON.stringify(errorContext.additionalInfo))
            : undefined
    };

    // 格式化输出
    const formattedMessage = `[${errorContext.operation.toUpperCase()}] ${safeMessage}`;

    // 根据级别输出
    switch (level) {
        case ErrorLevel.INFO:
            console.debug(formattedMessage);
            break;
        case ErrorLevel.WARN:
            console.warn(formattedMessage);
            break;
        case ErrorLevel.ERROR:
            console.error(formattedMessage);
            if (errorStack) {
                console.error('Stack trace:', filterSensitiveInfo(errorStack));
            }
            break;
    }

    // 输出上下文信息（仅在开发环境）
    if (typeof process !== 'undefined' && process.env.NODE_ENV === 'development') {
        console.debug('Error context:', safeContext);
    }
}

/**
 * 处理上传相关错误
 * @param error 错误对象
 * @param filename 文件名
 */
export function handleUploadError(error: unknown, filename?: string): void {
    handleError(error, {
        operation: 'FileUpload',
        filename,
        additionalInfo: {
            timestamp: new Date().toISOString()
        }
    });
}
