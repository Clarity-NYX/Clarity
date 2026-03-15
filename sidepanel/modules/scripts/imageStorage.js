// ============================================================
// IMAGE STORAGE - Server-Proxied Firebase Storage
// ============================================================
// All uploads/downloads go through the Clarity API server.
// No Firebase credentials or bucket names are exposed to the client.

import { apiRequest } from '../../utils/api.js';

// Initialize (no-op — server handles everything)
export const initImageStorage = async () => {
  console.log('[ImageStorage] ✅ Server-proxied storage ready');
  return true;
};

// Store media (image or video) via server proxy
export const storeImage = async (imageData, metadata = {}) => {
  const isVideo = metadata.mediaType === 'video' || imageData.startsWith('data:video/');
  const scriptId = metadata.scriptId || 'unknown';

  // Detect content type from base64 header
  const contentType = imageData.split(';base64,')[0]?.split(':')[1] || (isVideo ? 'video/mp4' : 'image/jpeg');

  console.log(`[ImageStorage] 📤 Uploading ${isVideo ? 'video' : 'image'} for script ${scriptId} (${contentType})`);

  try {
    const result = await apiRequest('/storage/upload', {
      method: 'POST',
      body: JSON.stringify({
        data: imageData,
        contentType,
        scriptId,
        mediaType: isVideo ? 'video' : 'image'
      }),
      retryEnabled: false // Don't retry large uploads
    });

    console.log(`[ImageStorage] ✅ Uploaded: ${result.storagePath}`);

    return {
      id: result.id,
      downloadURL: result.downloadURL,
      storagePath: result.storagePath
    };
  } catch (error) {
    console.error('[ImageStorage] Upload failed:', error);
    throw error;
  }
};

// Get image download URL via server
export const getImage = async (storagePath) => {
  try {
    const result = await apiRequest('/storage/url', {
      method: 'POST',
      body: JSON.stringify({ storagePath })
    });
    return { downloadURL: result.downloadURL };
  } catch (error) {
    console.error('[ImageStorage] Failed to get image:', error);
    return null;
  }
};

// Get multiple images by storage paths
export const getImages = async (storagePaths) => {
  if (!storagePaths || storagePaths.length === 0) return [];

  const promises = storagePaths.map(path => getImage(path));
  const results = await Promise.all(promises);
  return results.filter(r => r !== null);
};

// Delete image via server
export const deleteImage = async (storagePath) => {
  try {
    const result = await apiRequest('/storage/delete', {
      method: 'DELETE',
      body: JSON.stringify({ storagePath })
    });
    console.log(`[ImageStorage] 🗑️ Deleted: ${storagePath}`);
    return result.success;
  } catch (error) {
    console.error('[ImageStorage] Failed to delete image:', error);
    return false;
  }
};

// Delete all images for a script
export const deleteImagesForScript = async (scriptId) => {
  console.warn('[ImageStorage] deleteImagesForScript — needs tracking or server-side list');
  return 0;
};

// Get all images for a script
export const getImagesForScript = async (scriptId) => {
  console.warn('[ImageStorage] getImagesForScript — not implemented');
  return [];
};

// Get storage stats
export const getStorageStats = async () => {
  return {
    count: 'N/A',
    totalSizeBytes: 0,
    totalSizeMB: 'N/A (Server-proxied Firebase Storage)'
  };
};

// Clear all images (not implemented for safety)
export const clearAllImages = async () => {
  console.warn('[ImageStorage] ⚠️ clearAllImages not implemented');
  return false;
};

export default {
  initImageStorage,
  storeImage,
  getImage,
  getImages,
  deleteImage,
  deleteImagesForScript,
  getImagesForScript,
  getStorageStats,
  clearAllImages
};
