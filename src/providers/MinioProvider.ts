import { IOssProvider, OssImage } from "../types/oss";
import { MinioSettings, PluginSettings } from "../types/settings";
import { Setting, Notice, requestUrl, RequestUrlParam } from "obsidian";
import { handleUploadError } from "../utils/ErrorHandler";
import mime from 'mime';
import * as aws4 from "aws4";

export class MinioProvider implements IOssProvider {
    name = "minio";

    constructor(private settings: MinioSettings) {}

    updateSettings(settings: MinioSettings) {
        this.settings = settings;
    }

    async upload(
        file: File, 
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string> {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = file.type || mime.getType(file.name) || 'application/octet-stream';

            const opts = {
                host: `${this.settings.endpoint}:${this.settings.port}`,
                path: `/${this.settings.bucket}/${path}`,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'PUT',
                body: buffer,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': String(buffer.length)
                }
            };

            this.signRequest(opts);

            const headers = { ...opts.headers } as any;
            delete headers['Host'];

            const requestParams: RequestUrlParam = {
                url: this.getUrl(opts.path),
                method: 'PUT',
                headers: headers as Record<string, string>,
                body: arrayBuffer
            };

            // Note: requestUrl does not support progress events.
            // If progress is critical, we might need a different approach or accept the limitation.
            // For now, we simulate 0% -> 100%
            if (onProgress) onProgress({ loaded: 0, total: buffer.length, percentage: 0 });
            
            const response = await requestUrl(requestParams);

            if (response.status >= 200 && response.status < 300) {
                if (onProgress) onProgress({ loaded: buffer.length, total: buffer.length, percentage: 100 });
                return this.generateAccessUrl(path);
            } else {
                throw new Error(`Upload failed with status ${response.status}`);
            }

        } catch (error) {
            handleUploadError(error, file.name);
            throw error;
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        try {
            // Construct query parameters for ListObjects V2
            const queryParams = new URLSearchParams({
                'list-type': '2'
            });

            if (prefix) {
                queryParams.append('prefix', prefix);
            }

            const queryString = queryParams.toString();
            const path = `/${this.settings.bucket}${queryString ? '?' + queryString : ''}`;

            // Ensure endpoint doesn't have protocol
            const cleanEndpoint = this.settings.endpoint.replace(/^https?:\/\//, '');

            const opts = {
                host: `${cleanEndpoint}:${this.settings.port}`,
                path: path,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'GET',
                headers: {
                    'Accept': 'application/xml'
                }
            };

            this.signRequest(opts);

            const headers = { ...opts.headers } as any;
            delete headers['Host'];

            const url = this.getUrl(path);
            console.log('Minio ListImages Request:', {
                url,
                headers: headers
            });

            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: headers as Record<string, string>
            });

            if (response.status === 200) {
                return this.parseListObjectsResponse(response.text);
            } else {
                console.error('List objects failed with status:', response.status, response.text);
                throw new Error(`List objects failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("List images failed:", error);
            throw error;
        }
    }

    async deleteImage(key: string): Promise<void> {
        try {
            const path = `/${this.settings.bucket}/${key}`;
            const cleanEndpoint = this.settings.endpoint.replace(/^https?:\/\//, '');
            
            const opts = {
                host: `${cleanEndpoint}:${this.settings.port}`,
                path: path,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'DELETE',
                headers: {}
            };

            this.signRequest(opts);

            const headers = { ...opts.headers } as any;
            delete headers['Host'];

            const url = this.getUrl(path);
            console.log('Minio DeleteImage Request:', {
                url,
                headers: headers
            });

            const response = await requestUrl({
                url: url,
                method: 'DELETE',
                headers: headers as Record<string, string>
            });

            if (response.status >= 200 && response.status < 300) {
                return;
            } else {
                throw new Error(`Delete failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("Delete image failed:", error);
            throw error;
        }
    }

    private signRequest(opts: any) {
        aws4.sign(opts, {
            accessKeyId: this.settings.accessKey,
            secretAccessKey: this.settings.secretKey
        });
    }

    private getUrl(path: string): string {
        const protocol = this.settings.useSSL ? 'https' : 'http';
        // Ensure endpoint doesn't have protocol
        const cleanEndpoint = this.settings.endpoint.replace(/^https?:\/\//, '');
        const portStr = (this.settings.port === 443 || this.settings.port === 80) ? '' : `:${this.settings.port}`;
        return `${protocol}://${cleanEndpoint}${portStr}${path}`;
    }

    private parseListObjectsResponse(xml: string): OssImage[] {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xml, "text/xml");
        const contents = xmlDoc.getElementsByTagName("Contents");
        const images: OssImage[] = [];

        for (let i = 0; i < contents.length; i++) {
            const item = contents[i];
            const key = item.getElementsByTagName("Key")[0]?.textContent;
            const lastModified = item.getElementsByTagName("LastModified")[0]?.textContent;
            const size = item.getElementsByTagName("Size")[0]?.textContent;

            if (key && this.isImage(key)) {
                images.push({
                    key: key,
                    url: this.generateAccessUrl(key),
                    lastModified: lastModified ? new Date(lastModified) : new Date(),
                    size: size ? parseInt(size) : 0
                });
            }
        }
        return images;
    }

    private isImage(filename: string): boolean {
        const ext = filename.split('.').pop()?.toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext || '');
    }

    private generateAccessUrl(objectName: string): string {
        const { endpoint, port, useSSL, bucket, customDomain } = this.settings;
        
        if (customDomain) {
             let url = customDomain.replace(/\/+$/, '');
             if (!/^https?:\/\//i.test(url)) {
                 url = `https://${url}`;
             }
             return `${url}/${bucket}/${objectName}`;
        }

        const protocol = useSSL ? 'https' : 'http';
        const portStr = (port === 443 || port === 80) ? '' : `:${port}`;
        return `${protocol}://${endpoint}${portStr}/${bucket}/${objectName}`;
    }

    getSettingsTab(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const minioSettings = settings.providers.minio;

        new Setting(containerEl)
            .setName("Endpoint")
            .setDesc("Minio endpoint (e.g. play.min.io)")
            .addText(text => text
                .setValue(minioSettings.endpoint)
                .onChange(async (value) => {
                    minioSettings.endpoint = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName("Port")
            .setDesc("Minio port")
            .addText(text => text
                .setValue(String(minioSettings.port))
                .onChange(async (value) => {
                    minioSettings.port = Number(value);
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName("Use SSL")
            .addToggle(toggle => toggle
                .setValue(minioSettings.useSSL)
                .onChange(async (value) => {
                    minioSettings.useSSL = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName("Access Key")
            .addText(text => text
                .setValue(minioSettings.accessKey)
                .onChange(async (value) => {
                    minioSettings.accessKey = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName("Secret Key")
            .addText(text => text
                .setPlaceholder("Secret Key")
                .setValue(minioSettings.secretKey)
                .onChange(async (value) => {
                    minioSettings.secretKey = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName("Bucket")
            .addText(text => text
                .setValue(minioSettings.bucket)
                .onChange(async (value) => {
                    minioSettings.bucket = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Region")
            .addText(text => text
                .setValue(minioSettings.region)
                .onChange(async (value) => {
                    minioSettings.region = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName("Custom Domain")
            .setDesc("Optional custom domain for public access")
            .addText(text => text
                .setValue(minioSettings.customDomain)
                .onChange(async (value) => {
                    minioSettings.customDomain = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));
    }
}
