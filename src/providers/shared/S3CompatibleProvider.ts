import { requestUrl, RequestUrlParam } from 'obsidian';
import mime from 'mime';
import * as aws4 from 'aws4';
import { IOssProvider, OssImage, UploadProgressInfo } from '../../types/oss';
import { PluginSettings } from '../../types/settings';
import { extractSignedHeaders } from './aws4helpers';
import { parseS3ListObjectsPage, parseS3ListObjectsXml } from './s3xml';

interface S3Credentials {
    accessKeyId: string;
    secretAccessKey: string;
}

interface PreparedUpload {
    arrayBuffer: ArrayBuffer;
    bufferLength: number;
    request: aws4.Request;
}

/**
 * Owns the S3-compatible request lifecycle while leaving endpoint policy,
 * path style, access URLs, and provider-specific error behavior to subclasses.
 */
export abstract class S3CompatibleProvider<TSettings> implements IOssProvider {
    abstract name: string;

    protected constructor(protected settings: TSettings) {}

    protected abstract isConfigured(): boolean;
    protected abstract getConfigurationError(): Error;
    protected abstract getCredentials(): S3Credentials;
    protected abstract getSignedHost(): string;
    protected abstract getRegion(): string;
    protected abstract getRequestUrl(path: string): string;
    protected abstract getObjectRequestPath(objectKey: string): string;
    protected abstract getListRequestPath(query: string): string;
    protected abstract generateAccessUrl(objectKey: string): string;
    protected abstract handleUploadError(error: unknown, fileName: string): never;
    protected abstract handleListError(error: unknown): never;
    protected abstract handleDeleteError(error: unknown): never;

    abstract renderSettings(
        containerEl: HTMLElement,
        settings: PluginSettings,
        saveSettings: () => Promise<void>
    ): void;

    protected catchUploadPreparationErrors(): boolean {
        return false;
    }

    protected canListImages(): boolean {
        return this.isConfigured();
    }

    protected canDeleteImage(): boolean {
        return this.isConfigured();
    }

    protected logListResponseFailure(_status: number, _responseText: string): void {}

    protected uploadStatusError(status: number): Error {
        return new Error(`Upload failed with status: ${status}`);
    }

    protected deleteStatusError(status: number): Error {
        return new Error(`Delete failed with status: ${status}`);
    }

    private signRequest(request: aws4.Request): void {
        aws4.sign(request, this.getCredentials());
    }

    private async prepareUpload(file: File, path: string): Promise<PreparedUpload> {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = file.type || mime.getType(file.name) || 'application/octet-stream';
        const requestPath = this.getObjectRequestPath(path);
        const request = {
            host: this.getSignedHost(),
            path: requestPath,
            service: 's3',
            region: this.getRegion(),
            method: 'PUT',
            body: buffer,
            headers: {
                'Content-Type': contentType,
            },
        };

        this.signRequest(request);
        return { arrayBuffer, bufferLength: buffer.length, request };
    }

    private async sendUpload(
        prepared: PreparedUpload,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void,
        preparedRequestParams?: RequestUrlParam
    ): Promise<string> {
        const requestParams = preparedRequestParams ?? this.createUploadRequestParams(prepared);
        const response = await requestUrl(requestParams);

        if (response.status < 200 || response.status >= 300) {
            throw this.uploadStatusError(response.status);
        }

        if (onProgress) {
            onProgress({
                loaded: prepared.bufferLength,
                total: prepared.bufferLength,
                percentage: 100,
            });
        }
        return this.generateAccessUrl(path);
    }

    private createUploadRequestParams(prepared: PreparedUpload): RequestUrlParam {
        return {
            url: this.getRequestUrl(prepared.request.path as string),
            method: 'PUT',
            headers: extractSignedHeaders(prepared.request.headers as Record<string, string>),
            body: prepared.arrayBuffer,
        };
    }

    private async uploadConfigured(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        const prepared = await this.prepareUpload(file, path);
        const requestParams = this.createUploadRequestParams(prepared);
        if (onProgress) {
            onProgress({ loaded: 0, total: prepared.bufferLength, percentage: 0 });
        }
        return this.sendUpload(prepared, path, onProgress, requestParams);
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.isConfigured()) {
            throw this.getConfigurationError();
        }

        if (this.catchUploadPreparationErrors()) {
            try {
                return await this.uploadConfigured(file, path, onProgress);
            } catch (error) {
                return this.handleUploadError(error, file.name);
            }
        }

        const prepared = await this.prepareUpload(file, path);
        if (onProgress) {
            onProgress({ loaded: 0, total: prepared.bufferLength, percentage: 0 });
        }

        try {
            return await this.sendUpload(prepared, path, onProgress);
        } catch (error) {
            return this.handleUploadError(error, file.name);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        if (!this.canListImages()) {
            return [];
        }

        try {
            const images: OssImage[] = [];
            let continuationToken: string | undefined;

            do {
                const queryParams = new URLSearchParams({
                    'list-type': '2',
                    'max-keys': '1000',
                });
                if (prefix) {
                    queryParams.append('prefix', prefix);
                }
                if (continuationToken) {
                    queryParams.append('continuation-token', continuationToken);
                }

                const requestPath = this.getListRequestPath(queryParams.toString());
                const request = {
                    host: this.getSignedHost(),
                    path: requestPath,
                    service: 's3',
                    region: this.getRegion(),
                    method: 'GET',
                    headers: {
                        'Accept': 'application/xml',
                    },
                };

                this.signRequest(request);

                const response = await requestUrl({
                    url: this.getRequestUrl(requestPath),
                    method: 'GET',
                    headers: extractSignedHeaders(request.headers),
                });

                if (response.status !== 200) {
                    this.logListResponseFailure(response.status, response.text);
                    throw new Error(`List objects failed with status ${response.status}`);
                }

                images.push(
                    ...parseS3ListObjectsXml(
                        response.text,
                        (key) => this.generateAccessUrl(key)
                    )
                );

                const page = parseS3ListObjectsPage(response.text);
                continuationToken = page.isTruncated
                    ? page.nextContinuationToken
                    : undefined;
            } while (continuationToken);

            return images;
        } catch (error) {
            return this.handleListError(error);
        }
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.canDeleteImage()) {
            throw this.getConfigurationError();
        }

        try {
            const requestPath = this.getObjectRequestPath(key);
            const request = {
                host: this.getSignedHost(),
                path: requestPath,
                service: 's3',
                region: this.getRegion(),
                method: 'DELETE',
                headers: {},
            };

            this.signRequest(request);

            const response = await requestUrl({
                url: this.getRequestUrl(requestPath),
                method: 'DELETE',
                headers: extractSignedHeaders(request.headers),
            });

            if (response.status < 200 || response.status >= 300) {
                throw this.deleteStatusError(response.status);
            }
        } catch (error) {
            this.handleDeleteError(error);
        }
    }
}
