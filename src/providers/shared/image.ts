export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.avif'];

/**
 * Check if a filename/key refers to an image by extension.
 */
export function isImageFile(key: string): boolean {
    const ext = key.toLowerCase().substring(key.lastIndexOf('.'));
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * TIFF keys: listed as images, but Chromium's <img> can't render them, so
 * the gallery shows a placeholder tile instead of requesting them.
 */
export function isTiffKey(key: string): boolean {
    return /\.tiff?$/i.test(key.split(/[?#]/)[0] ?? key);
}
