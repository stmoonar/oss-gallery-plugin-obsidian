import { IOssProvider, OssImage, UploadProgressInfo } from "../types/oss";
import { MinioSettings, PluginSettings } from "../types/settings";
import { Setting, requestUrl, RequestUrlParam } from "obsidian";
import { handleUploadError } from "../utils/ErrorHandler";
import { encodeObjectKeyForUrl, normalizeEndpointHost } from './shared/path';
import { parseS3ListObjectsXml } from './shared/s3xml';
import { extractSignedHeaders } from './shared/aws4helpers';
import mime from 'mime';
import * as aws4 from "aws4";

export class MinioProvider implements IOssProvider {
    name = "minio";

    constructor(private settings: MinioSettings) {}

    private getEndpointUrl(): URL {
        const protocol = this.settings.useSSL ? 'https' : 'http';
        const host = normalizeEndpointHost(this.settings.endpoint, protocol);
        const url = new URL(`${protocol}://${host}`);
        if (!url.port) {
            url.port = String(this.settings.port);
        }
        return url;
    }

    private getSignedHost(): string {
        return this.getEndpointUrl().host;
    }

    updateSettings(settings: MinioSettings) {
        this.settings = settings;
    }

    async upload(
        file: File, 
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = file.type || mime.getType(file.name) || 'application/octet-stream';

            const bucket = this.settings.bucket.trim();
            const encodedPath = encodeObjectKeyForUrl(path);
            const opts = {
                host: this.getSignedHost(),
                path: `/${bucket}/${encodedPath}`,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'PUT',
                body: buffer,
                headers: {
                    'Content-Type': contentType,
                }
            };

            this.signRequest(opts);

            const requestParams: RequestUrlParam = {
                url: this.getUrl(opts.path),
                method: 'PUT',
                headers: extractSignedHeaders(opts.headers as Record<string, string>),
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
            const bucket = this.settings.bucket.trim();
            // Construct query parameters for ListObjects V2
            const queryParams = new URLSearchParams({
                'list-type': '2'
            });

            if (prefix) {
                queryParams.append('prefix', prefix);
            }

            const queryString = queryParams.toString();
            const path = `/${bucket}${queryString ? '?' + queryString : ''}`;

            const opts = {
                host: this.getSignedHost(),
                path: path,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'GET',
                headers: {
                    'Accept': 'application/xml'
                }
            };

            this.signRequest(opts);

            const response = await requestUrl({
                url: this.getUrl(path),
                method: 'GET',
                headers: extractSignedHeaders(opts.headers as Record<string, string>),
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
            const bucket = this.settings.bucket.trim();
            const path = `/${bucket}/${encodeObjectKeyForUrl(key)}`;
            const opts = {
                host: this.getSignedHost(),
                path: path,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'DELETE',
                headers: {}
            };

            this.signRequest(opts);

            const response = await requestUrl({
                url: this.getUrl(path),
                method: 'DELETE',
                headers: extractSignedHeaders(opts.headers as Record<string, string>),
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

    private signRequest(opts: Parameters<typeof aws4.sign>[0]) {
        aws4.sign(opts, {
            accessKeyId: this.settings.accessKey,
            secretAccessKey: this.settings.secretKey
        });
    }

    private getUrl(path: string): string {
        return `${this.getEndpointUrl().origin}${path}`;
    }

    private parseListObjectsResponse(xml: string): OssImage[] {
        return parseS3ListObjectsXml(xml, (key) => this.generateAccessUrl(key));
    }

    private generateAccessUrl(objectName: string): string {
        const { customDomain } = this.settings;
        const bucket = this.settings.bucket.trim();
        const encodedObjectName = encodeObjectKeyForUrl(objectName);
        
        if (customDomain) {
             let url = customDomain.replace(/\/+$/, '');
             if (!/^https?:\/\//i.test(url)) {
                 url = `https://${url}`;
             }
             return `${url}/${bucket}/${encodedObjectName}`;
        }

        return `${this.getEndpointUrl().origin}/${bucket}/${encodedObjectName}`;
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
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
