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
    additionalInfo?: Record<string, any>;
}

/**
 * 敏感信息模式列表
 */
const SENSITIVE_PATTERNS = [
    /access[_-]?key/i,
    /secret[_-]?key/i,
    /password/i,
    /token/i,
    /auth/i,
    /credential/i,
    /endpoint.*\..*\./i
];

/**
 * 过滤敏感信息
 * @param message 原始消息
 * @returns 过滤后的消息
 */
function filterSensitiveInfo(message: string): string {
    let filtered = message;

    SENSITIVE_PATTERNS.forEach(pattern => {
        filtered = filtered.replace(pattern, '[REDACTED]');
    });

    // 过滤可能的 URL 查询参数中的敏感信息
    filtered = filtered.replace(/\?([^\s&]*=)[^&\s]*/g, '$1[REDACTED]');

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
            console.info(formattedMessage);
            break;
        case ErrorLevel.WARN:
            console.warn(formattedMessage);
            break;
        case ErrorLevel.ERROR:
            console.error(formattedMessage);
            if (errorStack) {
                console.error('Stack trace:', errorStack);
            }
            break;
    }

    // 输出上下文信息（仅在开发环境）
    if (process.env.NODE_ENV === 'development') {
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

/**
 * 处理网络请求错误
 * @param error 错误对象
 * @param url 请求 URL
 */
export function handleNetworkError(error: unknown, url: string): void {
    handleError(error, {
        operation: 'NetworkRequest',
        additionalInfo: {
            url: url.replace(/\?.*/, '?[REDACTED]'),
            timestamp: new Date().toISOString()
        }
    });
}

/**
 * 创建用户友好的错误消息
 * @param error 错误对象
 * @param defaultMessage 默认消息
 * @returns 用户友好的错误消息
 */
export function createUserFriendlyMessage(
    error: unknown,
    defaultMessage: string = '操作失败，请稍后重试'
): string {
    if (error instanceof Error) {
        // 常见错误映射
        const errorMap: Record<string, string> = {
            'Network Error': '网络连接失败，请检查网络设置',
            'Timeout': '请求超时，请稍后重试',
            'Unauthorized': '认证失败，请检查配置信息',
            'Forbidden': '权限不足，请检查访问权限',
            'Not Found': '资源不存在',
            'ECONNREFUSED': '连接被拒绝，请检查服务器地址',
            'ENOTFOUND': '服务器地址无法解析，请检查 DNS 设置',
            'ERR_INVALID_ARGUMENT': '请求参数无效，请检查存储配置以及文件名或路径中的特殊字符',
            'ERR_SSL_PROTOCOL_ERROR': 'SSL 握手失败，请检查 Use SSL、端口以及 HTTPS 反向代理或证书配置'
        };

        for (const [key, value] of Object.entries(errorMap)) {
            if (error.message.includes(key)) {
                return value;
            }
        }
    }

    return defaultMessage;
}
