// ============================================================
// IMAGE STORAGE - Firebase Storage REST API for Script Images
// ============================================================
// Uses Firebase Storage REST API to avoid CSP issues with Firebase SDK
// Images are uploaded via REST and URLs are saved to Firestore

// Firebase Storage config for schedulo project
const STORAGE_CONFIG = {
  bucket: 'schedulo-33bd7.firebasestorage.app',
  apiKey: 'AIzaSyAff_0XL-ebsj3Em9Tw9NuWDcXeeC39QeY'
};

// Initialize (no-op for REST API approach)
export const initImageStorage = async () => {
  console.log('[ImageStorage] ✅ Firebase Storage REST API ready');
  return true;
};

// Convert base64 to Blob for upload
const base64ToBlob = (base64) => {
  const parts = base64.split(';base64,');
  const contentType = parts[0].split(':')[1] || 'image/jpeg';
  const raw = atob(parts[1]);
  const rawLength = raw.length;
  const uInt8Array = new Uint8Array(rawLength);
  
  for (let i = 0; i < rawLength; ++i) {
    uInt8Array[i] = raw.charCodeAt(i);
  }
  
  return new Blob([uInt8Array], { type: contentType });
};

// Store media (image or video) in Firebase Storage via REST API
export const storeImage = async (imageData, metadata = {}) => {
  const isVideo = metadata.mediaType === 'video' || imageData.startsWith('data:video/');
  const prefix = isVideo ? 'vid' : 'img';
  const id = `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const scriptId = metadata.scriptId || 'unknown';
  
  // Detect file extension from base64 content type
  const contentType = imageData.split(';base64,')[0]?.split(':')[1] || (isVideo ? 'video/mp4' : 'image/jpeg');
  const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
                   'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
  const ext = extMap[contentType] || (isVideo ? '.mp4' : '.jpg');
  
  const fileName = `${id}${ext}`;
  const storagePath = `scripts/${scriptId}/${fileName}`;
  
  // URL encode the path for the API
  const encodedPath = encodeURIComponent(storagePath);
  
  try {
    // Convert base64 to blob (preserves original content type)
    const blob = base64ToBlob(imageData);
    
    // Upload URL for Firebase Storage
    const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_CONFIG.bucket}/o/${encodedPath}`;
    
    console.log(`[ImageStorage] 📤 Uploading ${isVideo ? 'video' : 'image'} to: ${storagePath} (${contentType})`);
    
    // Upload the file with correct content type
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentType
      },
      body: blob
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('[ImageStorage] Upload failed:', errorText);
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }
    
    const uploadResult = await uploadResponse.json();
    console.log('[ImageStorage] ✅ Upload successful:', uploadResult.name);
    
    // Get the download token from the response
    const downloadToken = uploadResult.downloadTokens;
    
    // Construct the download URL
    const downloadURL = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_CONFIG.bucket}/o/${encodedPath}?alt=media&token=${downloadToken}`;
    
    console.log(`[ImageStorage] 📥 Download URL ready`);
    
    return {
      id,
      downloadURL,
      storagePath
    };
  } catch (error) {
    console.error('[ImageStorage] Failed to upload image:', error);
    throw error;
  }
};

// Get image download URL (for existing images)
export const getImage = async (storagePath) => {
  try {
    const encodedPath = encodeURIComponent(storagePath);
    const metadataUrl = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_CONFIG.bucket}/o/${encodedPath}`;
    
    const response = await fetch(metadataUrl);
    if (!response.ok) {
      return null;
    }
    
    const metadata = await response.json();
    const downloadToken = metadata.downloadTokens;
    const downloadURL = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_CONFIG.bucket}/o/${encodedPath}?alt=media&token=${downloadToken}`;
    
    return { downloadURL };
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

// Delete image from Firebase Storage via REST API
export const deleteImage = async (storagePath) => {
  try {
    const encodedPath = encodeURIComponent(storagePath);
    const deleteUrl = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_CONFIG.bucket}/o/${encodedPath}`;
    
    const response = await fetch(deleteUrl, {
      method: 'DELETE'
    });
    
    if (response.ok || response.status === 404) {
      console.log(`[ImageStorage] 🗑️ Deleted: ${storagePath}`);
      return true;
    }
    
    console.error('[ImageStorage] Delete failed:', response.status);
    return false;
  } catch (error) {
    console.error('[ImageStorage] Failed to delete image:', error);
    return false;
  }
};

// Delete all images for a script (lists then deletes)
export const deleteImagesForScript = async (scriptId) => {
  // Note: Firebase Storage REST API doesn't support listing objects easily
  // This would need to be tracked separately or done via Firebase Admin SDK
  console.warn('[ImageStorage] deleteImagesForScript requires manual cleanup or tracking');
  return 0;
};

// Get all images for a script
export const getImagesForScript = async (scriptId) => {
  // Note: Listing requires Firebase Admin SDK or tracking references
  console.warn('[ImageStorage] getImagesForScript not implemented for REST API');
  return [];
};

// Get storage stats (not available via REST API)
export const getStorageStats = async () => {
  return {
    count: 'N/A',
    totalSizeBytes: 0,
    totalSizeMB: 'N/A (Firebase Storage)'
  };
};

// Clear all images (not implemented for safety)
export const clearAllImages = async () => {
  console.warn('[ImageStorage] ⚠️ clearAllImages not implemented');
  return false;
};

// Export for use
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
