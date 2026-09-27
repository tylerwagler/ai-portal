import { useEffect, useState } from 'react';

import { Centered, ErrorNote } from '../components/Layout';
import { api } from '../lib/api';

/** Hands the signed-in admin over to the system dashboard's own host. */
export default function Dashboard() {
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<{ url: string }>('/dashboard/code', { method: 'POST' })
      .then(({ url }) => window.location.replace(url))
      .catch((err: Error) => setError(err.message));
  }, []);
  return <Centered>{error ? <ErrorNote>{error}</ErrorNote> : 'Opening the dashboard…'}</Centered>;
}
