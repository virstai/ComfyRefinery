import { reactive } from 'vue';

// A single app-wide lightbox: any thumbnail can call openLightbox(url, caption)
// and the <Lightbox> component (mounted once) shows it full size.
export const lightboxState = reactive({ url: null, caption: '' });

export function openLightbox(url, caption = '') {
  if (!url) return;
  lightboxState.url = url;
  lightboxState.caption = caption;
}

export function closeLightbox() {
  lightboxState.url = null;
  lightboxState.caption = '';
}
