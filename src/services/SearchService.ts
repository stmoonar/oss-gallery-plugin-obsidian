import { OssImage, SearchResult } from '../types/oss';
import { t } from '../i18n';
import { isImageFile } from '../utils/FileUtils';
import { handleError } from '../utils/ErrorHandler';

export class SearchService {
    private allImageUrls: Map<string, string> = new Map();

    constructor(private generateUrl: (objectName: string) => Promise<string>) {}

    /**
     * 执行搜索
     */
    async search(
        objects: OssImage[],
        searchText: string,
        useRegex: boolean = false
    ): Promise<SearchResult> {
        if (!searchText.trim()) {
            return {
                matchedObjects: objects,
                totalCount: objects.length
            };
        }

        const matchedObjects: OssImage[] = [];

        if (useRegex) {
            const result = await this.regexSearch(objects, searchText);
            matchedObjects.push(...result);
        } else {
            const result = await this.textSearch(objects, searchText);
            matchedObjects.push(...result);
        }

        return {
            matchedObjects,
            totalCount: matchedObjects.length
        };
    }

    /**
     * 正则表达式搜索
     */
    private async regexSearch(objects: OssImage[], searchText: string): Promise<OssImage[]> {
        const matchedObjects: OssImage[] = [];

        try {
            let regexPattern = searchText;

            // 智能处理通配符
            regexPattern = this.convertWildcardToRegex(regexPattern);

            const regex = new RegExp(regexPattern, 'i');

            for (const obj of objects) {
                if (!isImageFile(obj.key)) continue;

                const cachedUrl = this.allImageUrls.get(obj.key);
                let url = cachedUrl;
                
                if (!url) {
                    if (obj.url) {
                        url = obj.url;
                    } else {
                        url = await this.generateUrl(obj.key);
                    }
                }

                if (regex.test(url)) {
                    matchedObjects.push(obj);
                    if (!cachedUrl) {
                        this.allImageUrls.set(obj.key, url);
                    }
                }
            }
        } catch (error) {
            handleError(error, {
                operation: 'RegexSearch',
                additionalInfo: {
                    pattern: searchText
                }
            });
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`${t('Invalid regex pattern')}: ${errorMessage}`);
        }

        return matchedObjects;
    }

    /**
     * 普通文本搜索
     */
    private async textSearch(objects: OssImage[], searchText: string): Promise<OssImage[]> {
        const matchedObjects: OssImage[] = [];
        const lowerSearchText = searchText.toLowerCase();

        for (const obj of objects) {
            if (!isImageFile(obj.key)) continue;

            const cachedUrl = this.allImageUrls.get(obj.key);
            let url = cachedUrl;

            if (!url) {
                if (obj.url) {
                    url = obj.url;
                } else {
                    url = await this.generateUrl(obj.key);
                }
            }

            if (url.toLowerCase().includes(lowerSearchText)) {
                matchedObjects.push(obj);
                if (!cachedUrl) {
                    this.allImageUrls.set(obj.key, url);
                }
            }
        }

        return matchedObjects;
    }

    /**
     * 转换通配符为正则表达式
     */
    private convertWildcardToRegex(pattern: string): string {
        // 检查是否是简单的通配符模式
        const hasSpecialChars = /[()[?+]/.test(pattern);

        if (!hasSpecialChars) {
            if (pattern.startsWith('*') && pattern.endsWith('*')) {
                const innerPattern = pattern.slice(1, -1);
                return `.*${innerPattern}.*`;
            } else if (pattern.startsWith('*')) {
                // *foo -> match anything ending with foo
                const innerPattern = pattern.slice(1);
                return `.*${innerPattern}`;
            } else if (pattern.endsWith('*')) {
                // foo* -> match anything starting with foo
                const innerPattern = pattern.slice(0, -1);
                return `${innerPattern}.*`;
            }
        }

        return pattern;
    }

    
    /**
     * 清空URL缓存
     */
    clearCache(): void {
        this.allImageUrls.clear();
    }

    /**
     * 获取缓存大小
     */
    getCacheSize(): number {
        return this.allImageUrls.size;
    }
}