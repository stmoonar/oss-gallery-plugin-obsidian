import { OssImage, SearchResult } from '../types/oss';
import { t } from '../i18n';

export class SearchService {
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

        const matchedObjects = useRegex
            ? this.regexSearch(objects, searchText)
            : this.textSearch(objects, searchText);

        return {
            matchedObjects,
            totalCount: matchedObjects.length
        };
    }

    /**
     * 匹配目标：对象 key + 去掉查询串的 URL。
     * 预签名 URL 的查询串是随机签名，参与匹配只会产生误报。
     */
    private getSearchTarget(obj: OssImage): string {
        const urlWithoutQuery = obj.url ? obj.url.split('?')[0] : '';
        return `${obj.key} ${urlWithoutQuery}`;
    }

    /**
     * 正则表达式搜索
     */
    private regexSearch(objects: OssImage[], searchText: string): OssImage[] {
        let regex: RegExp;
        try {
            regex = new RegExp(this.convertWildcardToRegex(searchText), 'i');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`${t('Invalid regex pattern')}: ${errorMessage}`);
        }

        return objects.filter((obj) => regex.test(this.getSearchTarget(obj)));
    }

    /**
     * 普通文本搜索
     */
    private textSearch(objects: OssImage[], searchText: string): OssImage[] {
        const lowerSearchText = searchText.toLowerCase();

        return objects.filter((obj) =>
            this.getSearchTarget(obj).toLowerCase().includes(lowerSearchText)
        );
    }

    /**
     * 转换通配符为正则表达式。
     * 仅当模式除 * 外不含其他正则元字符时才按通配符处理，
     * 此时转义所有字符再把 * 展开为 .*，避免 "." 等被误当正则解释。
     */
    private convertWildcardToRegex(pattern: string): string {
        const hasOtherRegexChars = /[()[\]{}?+.\\^$|]/.test(pattern);
        if (pattern.includes('*') && !hasOtherRegexChars) {
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return escaped.replace(/\\\*/g, '.*');
        }
        return pattern;
    }
}
