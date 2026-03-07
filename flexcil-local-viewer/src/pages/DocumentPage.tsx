import { Navigate, useParams } from 'react-router-dom'

export function DocumentPage() {
  const { id } = useParams<{ id: string }>()
  if (!id) {
    return <Navigate to="/" replace />
  }

  return <Navigate to={`/workspace?doc=${encodeURIComponent(id)}`} replace />
}
