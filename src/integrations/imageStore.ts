import { v2 as cloudinary } from 'cloudinary';
import { AppError } from '../common/errors/AppError';
import { logger } from '../common/utils/logger';
import { env } from '../config/env';

export interface StoredImage {
  /** HTTPS delivery URL. This is the only thing we keep in our database. */
  url: string;
}

export interface ImageStore {
  /**
   * Saves the image under `publicId`. Uploading again with the same id replaces the old image,
   * so a re-upload never leaves an orphan behind.
   */
  upload(buffer: Buffer, publicId: string): Promise<StoredImage>;
  remove(publicId: string): Promise<void>;
}

/** Passport framing: 600x800 (3:4), cropped around the face, and capped in size. */
const PASSPORT_TRANSFORMATION = [{ width: 600, height: 800, crop: 'fill', gravity: 'face' }, { quality: 'auto', fetch_format: 'auto' }];

export function createCloudinaryImageStore(config: { cloudName: string; apiKey: string; apiSecret: string }): ImageStore {
  cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true });

  return {
    upload: (buffer, publicId) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { public_id: publicId, overwrite: true, invalidate: true, resource_type: 'image', transformation: PASSPORT_TRANSFORMATION },
          (error, result) => {
            if (error || !result) {
              logger.error({ err: error }, 'cloudinary upload failed');
              reject(new AppError('SERVICE_UNAVAILABLE'));
              return;
            }
            resolve({ url: result.secure_url });
          },
        );
        stream.end(buffer);
      }),

    async remove(publicId) {
      try {
        await cloudinary.uploader.destroy(publicId, { invalidate: true, resource_type: 'image' });
      } catch (err) {
        logger.error({ err }, 'cloudinary delete failed');
        throw new AppError('SERVICE_UNAVAILABLE');
      }
    },
  };
}

/** Used when Cloudinary is not configured: the API runs, and photo routes answer 503. */
export function createDisabledImageStore(): ImageStore {
  const unavailable = async (): Promise<never> => {
    logger.error('image not stored: Cloudinary is not configured');
    throw new AppError('SERVICE_UNAVAILABLE');
  };
  return { upload: unavailable, remove: unavailable };
}

export function createImageStore(): ImageStore {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = env;
  return cloudName && apiKey && apiSecret
    ? createCloudinaryImageStore({ cloudName, apiKey, apiSecret })
    : createDisabledImageStore();
}
