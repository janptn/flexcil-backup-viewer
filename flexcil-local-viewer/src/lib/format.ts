export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  const factor = Math.floor(Math.log(bytes) / Math.log(1024))
  const safeFactor = Math.min(factor, units.length - 1)
  const value = bytes / 1024 ** safeFactor
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[safeFactor]}`
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}
