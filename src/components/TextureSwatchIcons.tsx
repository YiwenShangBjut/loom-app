import type { MaterialTextureId } from '../rendering/materialTextures';

/** 纹理圆圈尺寸（与 CSS .materials-swatches-texture .materials-swatch 一致） */
const SIZE = 30;

/** 弹框示例图：`public/textures` 下与材质对应的 JPG */
const TEXTURE_IMAGES: Record<Exclude<MaterialTextureId, 'none'>, string> = {
  wool: './textures/yarn.jpg',
  thread: './textures/thread.jpg',
  chenille: './textures/yarn.jpg',
  felt: './textures/felt.jpg',
  steel: './textures/wire.jpg',
  rope: './textures/rope.jpg',
};

/** None: 斜横杠表示无材质 */
function IconNone() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect width="18" height="18" rx="9" fill="#e8e4dc" stroke="#4a4a4a" strokeWidth="1.4" />
      <line x1="4" y1="4" x2="14" y2="14" stroke="#4a4a4a" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 写实材质图片 */
function TextureImage({ id }: { id: Exclude<MaterialTextureId, 'none'> }) {
  const src = TEXTURE_IMAGES[id];
  return <img src={src} alt="" width={SIZE} height={SIZE} loading="lazy" aria-hidden />;
}

export function TextureSwatchIcon({ id }: { id: MaterialTextureId }) {
  if (id === 'none') return <IconNone />;
  return <TextureImage id={id} />;
}
