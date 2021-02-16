import { getEndpoint } from 'utils/common/apiUtil';
import HTTPService from './HTTPService';
import * as Comlink from 'comlink';
import localForage from 'localforage';
import { collection } from './collectionService';
import { MetadataObject } from './uploadService';

const CryptoWorker: any =
    typeof window !== 'undefined' &&
    Comlink.wrap(new Worker('worker/crypto.worker.js', { type: 'module' }));
const ENDPOINT = getEndpoint();

localForage.config({
    driver: localForage.INDEXEDDB,
    name: 'ente-files',
    version: 1.0,
    storeName: 'files',
});

const FILES = 'files';

export interface fileAttribute {
    encryptedData?: Uint8Array;
    objectKey?: string;
    decryptionHeader: string;
}

export interface user {
    id: number;
    name: string;
    email: string;
}

export interface file {
    id: number;
    collectionID: number;
    file: fileAttribute;
    thumbnail: fileAttribute;
    metadata: MetadataObject;
    encryptedKey: string;
    keyDecryptionNonce: string;
    key: string;
    src: string;
    msrc: string;
    html: string;
    w: number;
    h: number;
    isDeleted: boolean;
    dataIndex: number;
    updationTime: number;
}

export const syncData = async (token, collections) => {
    const { files: resp, isUpdated } = await syncFiles(token, collections);

    return {
        data: resp.map((item) => ({
            ...item,
            w: window.innerWidth,
            h: window.innerHeight,
        })),
        isUpdated,
    };
};

export const localFiles = async () => {
    let files: Array<file> = (await localForage.getItem<file[]>(FILES)) || [];
    return files;
};

export const syncFiles = async (token: string, collections: collection[]) => {
    let files = await localFiles();
    let isUpdated = false;
    files = await removeDeletedCollectionFiles(collections, files);
    for (let collection of collections) {
        const lastSyncTime =
            (await localForage.getItem<number>(`${collection.id}-time`)) ?? 0;
        if (collection.updationTime === lastSyncTime) {
            continue;
        }
        isUpdated = true;
        let fetchedFiles =
            (await getFiles(collection, lastSyncTime, 100, token)) ?? [];
        files.push(...fetchedFiles);
        var latestVersionFiles = new Map<number, file>();
        files.forEach((file) => {
            if (
                !latestVersionFiles.has(file.id) ||
                latestVersionFiles.get(file.id).updationTime < file.updationTime
            ) {
                latestVersionFiles.set(file.id, file);
            }
        });
        files = [];
        for (const [_, file] of latestVersionFiles) {
            if (file.isDeleted) {
                continue;
            }
            files.push(file);
        }
        files = files.sort(
            (a, b) => b.metadata.creationTime - a.metadata.creationTime
        );
        await localForage.setItem('files', files);
        await localForage.setItem(
            `${collection.id}-time`,
            collection.updationTime
        );
    }
    return { files, isUpdated };
};

export const getFiles = async (
    collection: collection,
    sinceTime: number,
    limit: number,
    token: string
): Promise<file[]> => {
    try {
        const worker = await new CryptoWorker();
        let promises: Promise<file>[] = [];
        let time =
            sinceTime ||
            (await localForage.getItem<number>(`${collection.id}-time`)) ||
            0;
        let resp;
        do {
            resp = await HTTPService.get(
                `${ENDPOINT}/collections/diff`,
                {
                    collectionID: collection.id.toString(),
                    sinceTime: time.toString(),
                    limit: limit.toString(),
                },
                {
                    'X-Auth-Token': token,
                }
            );
            promises.push(
                ...resp.data.diff.map(async (file: file) => {
                    if (!file.isDeleted) {
                        file.key = await worker.decryptB64(
                            file.encryptedKey,
                            file.keyDecryptionNonce,
                            collection.key
                        );
                        file.metadata = await worker.decryptMetadata(file);
                    }
                    return file;
                })
            );

            if (resp.data.diff.length) {
                time = resp.data.diff.slice(-1)[0].updationTime.toString();
            }
        } while (resp.data.diff.length === limit);
        return await Promise.all(promises);
    } catch (e) {
        console.log('Get files failed' + e);
    }
};
export const getPreview = async (token: string, file: file) => {
    try {
        const cache = await caches.open('thumbs');
        const cacheResp: Response = await cache.match(file.id.toString());
        if (cacheResp) {
            return URL.createObjectURL(await cacheResp.blob());
        }
        const resp = await HTTPService.get(
            `${ENDPOINT}/files/preview/${file.id}`,
            null,
            { 'X-Auth-Token': token },
            { responseType: 'arraybuffer' }
        );
        const worker = await new CryptoWorker();
        const decrypted: any = await worker.decryptThumbnail(
            new Uint8Array(resp.data),
            await worker.fromB64(file.thumbnail.decryptionHeader),
            file.key
        );
        try {
            await cache.put(
                file.id.toString(),
                new Response(new Blob([decrypted]))
            );
        } catch (e) {
            // TODO: handle storage full exception.
        }
        return URL.createObjectURL(new Blob([decrypted]));
    } catch (e) {
        console.log('get preview Failed' + e);
    }
};

export const getFile = async (token: string, file: file) => {
    try {
        const resp = await HTTPService.get(
            `${ENDPOINT}/files/download/${file.id}`,
            null,
            { 'X-Auth-Token': token },
            { responseType: 'arraybuffer' }
        );
        const worker = await new CryptoWorker();
        const decrypted: any = await worker.decryptFile(
            new Uint8Array(resp.data),
            await worker.fromB64(file.file.decryptionHeader),
            file.key
        );
        return URL.createObjectURL(new Blob([decrypted]));
    } catch (e) {
        console.log('get file failed ' + e);
    }
};

const removeDeletedCollectionFiles = async (
    collections: collection[],
    files: file[]
) => {
    const syncedCollectionIds = new Set<number>();
    for (let collection of collections) {
        syncedCollectionIds.add(collection.id);
    }
    files = files.filter((file) => syncedCollectionIds.has(file.collectionID));
    return files;
};
