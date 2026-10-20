import { renderSVG } from 'uqr';

/** Black-on-white QR (scanners want dark modules on a light field), medium error correction for printed tags. */
export function qrSvg(text: string, opts: { size?: number; border?: number } = {}): string {
  const svg = renderSVG(text, { ecc: 'M', border: opts.border ?? 2, pixelSize: 10, whiteColor: '#ffffff', blackColor: '#000000' });
  const size = opts.size ?? 240;
  const label = `QR code for ${text}`.replace(/[<>&"]/g, '');
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="${label}" `);
}
