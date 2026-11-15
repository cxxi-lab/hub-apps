(async () => {
  const colors = {"green": ["#80de9c", "#2ecc71"], "teal": ["#75cfb7", "#1abc9c"], "purple": ["#ab7cbf", "#9b59b6"], "red": ["#ec7d6d", "#e74c3c"], "orange": ["#eea26c", "#e67e22"], "yellow": ["#ffe180", "#f1c40f"]}
  const path = 'M32 100.641C32 68.391 54.1651 41.3515 84 34.1102V1.28125C36.3772 8.98855 0 50.5392 0 100.641C0 150.742 36.3772 192.293 84 200V167.171C54.1651 159.93 32 132.89 32 100.641ZM200 100.641C200 150.742 163.623 192.293 116 200V167.171C145.835 159.93 168 132.89 168 100.641C168 68.391 145.835 41.3515 116 34.1102V1.28125C163.623 8.98855 200 50.5392 200 100.641Z'
  const sizes = [16, 32, 48, 64, 128, 256, 512]
  const out = {}
  for (const [name, [from, to]] of Object.entries(colors)) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="157.5" y1="33.0763" x2="44.7421" y2="148.561" gradientUnits="userSpaceOnUse"><stop offset="0.0509862" stop-color="' + from + '"/><stop offset="1" stop-color="' + to + '"/></linearGradient></defs><path fill-rule="evenodd" clip-rule="evenodd" d="' + path + '" fill="url(#g)"/></svg>'
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + btoa(svg)
    await img.decode()
    out[name] = {}
    for (const size of sizes) {
      const c = document.createElement('canvas'); c.width = c.height = size
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
      // the mark fills the square, as the current icons do
      const inset = size * 0.045; g.drawImage(img, inset, inset, size - 2 * inset, size - 2 * inset)
      out[name][size] = c.toDataURL('image/png').split(',')[1]
    }
  }
  return out
})()
