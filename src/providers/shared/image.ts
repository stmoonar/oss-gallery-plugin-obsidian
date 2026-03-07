const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif'];

/**
 * Check if a filename/key refers to an image by extension.
 */
export function isImageFile(key: string): boolean {
    const ext = key.toLowerCase().substring(key.lastIndexOf('.'));
    return IMAGE_EXTENSIONS.includes(ext);
}
