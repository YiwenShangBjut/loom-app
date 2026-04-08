import { createHashRouter, RouterProvider } from 'react-router-dom';
import { CreationExportWorker } from './components/CreationExportWorker';
import { CreatePage } from './components/CreatePage';
import { CreationPage } from './components/CreationPage';
import { TryPage } from './components/TryPage';
import { AdminPage } from './components/AdminPage';
import { HomePage } from './components/HomePage';
import { CommunityPage } from './components/CommunityPage';

const router = createHashRouter([
  { path: '/', element: <HomePage /> },
  { path: '/create', element: <CreatePage /> },
  { path: '/creation', element: <CreationPage /> },
  { path: '/try', element: <TryPage /> },
  { path: '/community', element: <CommunityPage /> },
  { path: '/home', element: <HomePage /> },
  { path: '/admin', element: <AdminPage /> },
]);

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <CreationExportWorker />
    </>
  );
}
