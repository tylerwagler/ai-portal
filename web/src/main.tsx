import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import './app.css';
import { SignedIn } from './components/Layout';
import Account from './pages/Account';
import Admin from './pages/Admin';
import Dashboard from './pages/Dashboard';
import Cli from './pages/Cli';
import Consent from './pages/Consent';
import Login from './pages/Login';
import Logout from './pages/Logout';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Passwords are gone (Microsoft sign-in only); old reset links land on the sign-in page. */}
        <Route path="/reset" element={<Navigate to="/login" replace />} />
        <Route path="/logout" element={<Logout />} />
        <Route path="/oauth/consent" element={<Consent />} />
        <Route path="/cli" element={<SignedIn><Cli /></SignedIn>} />
        <Route path="/admin" element={<SignedIn><Admin /></SignedIn>} />
        <Route path="/dashboard" element={<SignedIn><Dashboard /></SignedIn>} />
        <Route path="*" element={<SignedIn><Account /></SignedIn>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
