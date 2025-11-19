import { SyncChanges, ServiceDependencies } from '../types/gallery';
import { OssImage } from '../types/oss';
import { ImageCache } from '../utils/ImageCache';

export class SyncService {
    constructor(private deps: ServiceDependencies) {}

    /**
     * Sync with remote server
     */
    async sync(localObjects: OssImage[]): Promise<{ objects: OssImage[]; changes: SyncChanges }> {
        try {
            const remoteObjects = await this.fetchRemoteObjects();
            const changes = this.detectChanges(localObjects, remoteObjects);

            if (changes.hasChanges) {
                // Clean up deleted files from cache
                changes.deleted.forEach(objectName => {
                    ImageCache.delete(objectName);
                });
            }

            return {
                objects: remoteObjects,
                changes
            };
        } catch (error) {
            console.error('Remote sync failed:', error);
            throw error;
        }
    }

    /**
     * Fetch remote objects
     */
    private async fetchRemoteObjects(): Promise<OssImage[]> {
        const objects = await this.deps.provider.listImages();
        return objects.sort((a, b) =>
            (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0)
        );
    }

    /**
     * Detect changes between local and remote
     */
    private detectChanges(local: OssImage[], remote: OssImage[]): SyncChanges {
        const localMap = new Map(local.map(obj => [obj.key, obj.lastModified]));
        const remoteMap = new Map(remote.map(obj => [obj.key, obj.lastModified]));

        const added: OssImage[] = [];
        const deleted: string[] = [];
        const modified: OssImage[] = [];
        let hasChanges = false;

        // Detect added and modified
        for (const [key, remoteModified] of remoteMap) {
            const localModified = localMap.get(key);

            if (!localModified) {
                added.push(remote.find(obj => obj.key === key)!);
                hasChanges = true;
            } else if (remoteModified?.getTime() !== localModified?.getTime()) {
                modified.push(remote.find(obj => obj.key === key)!);
                hasChanges = true;
            }
        }

        // Detect deleted
        for (const key of localMap.keys()) {
            if (!remoteMap.has(key)) {
                deleted.push(key);
                hasChanges = true;
            }
        }

        return { hasChanges, added, deleted, modified };
    }

    /**
     * Delete object
     */
    async deleteObject(objectName: string): Promise<void> {
        await this.deps.provider.deleteImage(objectName);
        ImageCache.delete(objectName);
    }
}