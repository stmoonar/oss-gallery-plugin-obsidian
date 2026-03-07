/**
 * 文件工具类，提供文件相关的通用功能
 */

/**
 * 图片文件扩展名列表
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

/**
 * 视频文件扩展名列表
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'];

/**
 * 音频文件扩展名列表
 */
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];

/**
 * 检查文件是否为图片类型
 * @param filename 文件名
 * @returns 是否为图片文件
 */
export function isImageFile(filename: string): boolean {
    return IMAGE_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

/**
 * 检查文件是否为视频类型
 * @param filename 文件名
 * @returns 是否为视频文件
 */
export function isVideoFile(filename: string): boolean {
    return VIDEO_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

/**
 * 检查文件是否为音频类型
 * @param filename 文件名
 * @returns 是否为音频文件
 */
export function isAudioFile(filename: string): boolean {
    return AUDIO_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

/**
 * 获取文件类型分类
 * @param filename 文件名
 * @returns 文件类型分类
 */
export function getFileType(filename: string): 'image' | 'video' | 'audio' | 'document' {
    if (isImageFile(filename)) return 'image';
    if (isVideoFile(filename)) return 'video';
    if (isAudioFile(filename)) return 'audio';
    return 'document';
}

/**
 * 根据 MIME 类型获取文件分类
 * @param file File 对象
 * @returns 文件类型分类，空字符串表示不支持
 */
export function getFileTypeByMime(file: File): string {
    if (file?.type.match(/video.*/)) return 'video';
    if (file?.type.match(/audio.*/)) return 'audio';
    if (file?.type.match(/application\/(vnd.*|pdf)/)) return 'doc';
    if (file?.type.match(/image.*/)) return 'image';
    return '';
}

/**
 * 获取文件扩展名
 * @param filename 文件名
 * @returns 文件扩展名（包含点号）
 */
export function getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot !== -1 ? filename.substring(lastDot).toLowerCase() : '';
}

/**
 * 从 URL 中提取文件名
 * @param url 文件 URL
 * @returns 文件名
 */
export function getFilenameFromUrl(url: string): string {
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    const queryIndex = filename.indexOf('?');
    return queryIndex !== -1 ? filename.substring(0, queryIndex) : filename;
}

/**
 * 格式化文件大小
 * @param bytes 字节数
 * @returns 格式化后的文件大小字符串
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}