// ============================================================
// IMAGE STORAGE - Direct Upload via Signed URLs
// ============================================================
// 1. Server generates a signed upload URL (small authenticated request)
// 2. Client uploads file directly to Firebase Storage (any size)
// 3. No file data goes through the server — scales to 500MB+ videos

import { apiRequest } from '../../utils/api.js';

// Initialize (no-op — server handles everything)
export const initImageStorage = async () => {
  console.log('[ImageStorage] ✅ Signed URL storage ready');
  return true;
};

// Convert base64 data URI to Blob
const base64ToBlob = (dataUri) => {
  const [header, base64Data] = dataUri.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const byteString = atob(base64Data);
  const arrayBuffer = new ArrayBuffer(byteString.length);
  const uint8Array = new Uint8Array(arrayBuffer);
  for (let i = 0; i < byteString.length; i++) {
    uint8Array[i] = byteString.charCodeAt(i);
  }
  return new Blob([arrayBuffer], { type: mime });
};

// Store media (image or video) via signed upload URL
export const storeImage = async (imageData, metadata = {}) => {
  const isVideo = metadata.mediaType === 'video' || imageData.startsWith('data:video/');
  const scriptId = metadata.scriptId || 'unknown';

  // Detect content type from base64 header
  const contentType = imageData.split(';base64,')[0]?.split(':')[1] || (isVideo ? 'video/mp4' : 'image/jpeg');

  console.log(`[ImageStorage] 📤 Uploading ${isVideo ? 'video' : 'image'} for script ${scriptId} (${contentType})`);

  try {
    // Step 1: Get signed upload URL from server (tiny request)
    const urlResult = await apiRequest('/storage/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        contentType,
        scriptId,
        mediaType: isVideo ? 'video' : 'image'
      })
    });

    if (!urlResult.success || !urlResult.uploadUrl) {
      throw new Error('Failed to get upload URL');
    }

    // Step 2: Convert base64 to blob
    const blob = base64ToBlob(imageData);
    console.log(`[ImageStorage] 📦 File size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    // Step 3: Upload directly to Firebase Storage via signed URL
    const uploadResponse = await fetch(urlResult.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: blob
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }

    console.log(`[ImageStorage] ✅ Uploaded: ${urlResult.storagePath}`);

    return {
      id: urlResult.id,
      downloadURL: urlResult.downloadUrl,
      storagePath: urlResult.storagePath
    };
  } catch (error) {
    console.error('[ImageStorage] Upload failed:', error);
    throw error;
  }
};

// Store from File object (for file picker — no base64 conversion needed)
export const storeFile = async (file, metadata = {}) => {
  const scriptId = metadata.scriptId || 'unknown';
  const isVideo = file.type.startsWith('video/');
  const contentType = file.type || (isVideo ? 'video/mp4' : 'image/jpeg');

  console.log(`[ImageStorage] 📤 Uploading file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

  try {
    // Step 1: Get signed upload URL
    const urlResult = await apiRequest('/storage/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        contentType,
        scriptId,
        mediaType: isVideo ? 'video' : 'image'
      })
    });

    if (!urlResult.success || !urlResult.uploadUrl) {
      throw new Error('Failed to get upload URL');
    }

    // Step 2: Upload file directly (no base64 conversion!)
    const uploadResponse = await fetch(urlResult.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: file
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }

    console.log(`[ImageStorage] ✅ Uploaded: ${urlResult.storagePath}`);

    return {
      id: urlResult.id,
      downloadURL: urlResult.downloadUrl,
      storagePath: urlResult.storagePath
    };
  } catch (error) {
    console.error('[ImageStorage] File upload failed:', error);
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
  console.warn('[ImageStorage] deleteImagesForScript — needs server-side list endpoint');
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
    totalSizeMB: 'N/A (Firebase Storage via signed URLs)'
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
  storeFile,
  getImage,
  getImages,
  deleteImage,
  deleteImagesForScript,
  getImagesForScript,
  getStorageStats,
  clearAllImages
};
