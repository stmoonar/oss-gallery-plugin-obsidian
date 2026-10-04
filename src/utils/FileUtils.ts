/**
 * 文件工具类，提供文件相关的通用功能
 */

/**
 * 根据 MIME 类型获取文件分类
 * @param file File 对象
 * @returns 文件类型分类，空字符串表示不支持
 */
export function getFileTypeByMime(file: File): string {
    if (file?.type.match(/video.*/)) return 'video';
    if (file?.type.match(/audio.*/)) return 'audio';
    if (file?.type.match(/application\/(vnd.*|pdf|msword)/)) return 'doc';
    if (file?.type.match(/image.*/)) return 'image';
    return '';
}
