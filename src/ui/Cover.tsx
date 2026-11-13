/* Cover unter dem Glas: Mit WebGL zeichnet glass/engine.ts das Bild (data-src) ins Hintergrundbild,
   die Glaslinse bricht es; das <img> dient dann nur noch als Platzhalter (data-gl="1" blendet es aus).
   Ohne WebGL oder wenn das Bild nicht als Textur geladen werden darf, bleibt das <img> sichtbar. */

export function Cover({ url }: { url?: string }) {
  return <span className="cover" data-src={url}>{url && <img src={url} alt="" loading="lazy" draggable={false} />}</span>
}

/** Glaszeile mit Cover, Titel und Unterzeilen; als Knopf, wenn onClick da ist. */
export function CoverRow(p: { image?: string; title: string; sub?: React.ReactNode; extra?: React.ReactNode; onClick?: () => void }) {
  const Tag = p.onClick ? 'button' : 'div'
  return <Tag className="row glass" onClick={p.onClick}>
    <Cover url={p.image} />
    <span className="meta"><b>{p.title}</b>{p.sub && <small>{p.sub}</small>}{p.extra}</span>
  </Tag>
}
