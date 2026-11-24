// Turn the composed message (text + attachments) into Baileys message contents.

// Only formats WhatsApp plays inline without conversion; everything else
// (HEIC, GIF, MOV, WAV, …) is sent as a document so it always arrives.
const IMAGE = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const VIDEO = new Set(['video/mp4', 'video/3gpp']);
const AUDIO = new Set(['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/x-m4a']);

/** @returns {'image'|'video'|'audio'|'document'} */
export function classify(mimetype) {
  const m = String(mimetype || '').toLowerCase().split(';')[0].trim();
  if (IMAGE.has(m)) return 'image';
  if (VIDEO.has(m)) return 'video';
  if (AUDIO.has(m)) return 'audio';
  return 'document';
}

function toContent(att) {
  const kind = classify(att.mimetype);
  const src = { url: att.path };
  switch (kind) {
    case 'image':
      return { image: src };
    case 'video':
      return { video: src, mimetype: att.mimetype };
    case 'audio':
      return { audio: src, mimetype: att.mimetype };
    default:
      return {
        document: src,
        mimetype: att.mimetype || 'application/octet-stream',
        fileName: att.originalName || 'file',
      };
  }
}

/**
 * Turn the ordered message sequence into Baileys message contents, keeping the
 * user's order. Each file may carry its own caption; audio cannot, so its caption
 * is sent as a text right before it.
 * @param {({type:'text', text:string} | {type:'file', file:{path:string, mimetype:string, originalName:string}, caption?:string})[]} items
 * @returns {object[]}
 */
export function buildSequence(items = []) {
  const out = [];
  for (const item of items || []) {
    if (item.type === 'text') {
      const t = String(item.text || '').trim();
      if (t) out.push({ text: t });
      continue;
    }
    if (item.type !== 'file' || !item.file) continue;
    const content = toContent(item.file);
    const caption = String(item.caption || '').trim();
    if (caption && content.audio) out.push({ text: caption });
    else if (caption) content.caption = caption;
    out.push(content);
  }
  return out;
}
