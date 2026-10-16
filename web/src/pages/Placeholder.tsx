export default function Placeholder({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="placeholder-page">
        <h2>{title}</h2>
        <p>本页面为占位，后续版本提供。</p>
      </div>
    </div>
  )
}
