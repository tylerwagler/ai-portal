import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import './app.css';
import { SignedIn } from './components/Layout';
import Account from './pages/Account';
import Admin from './pages/Admin';
import Cli from './pages/Cli';
import Consent from './pages/Consent';
import Login from './pages/Login';
import Logout from './pages/Logout';
import Reset from './pages/Reset';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/logout" element={<Logout />} />
        <Route path="/oauth/consent" element={<Consent />} />
        <Route path="/cli" element={<SignedIn><Cli /></SignedIn>} />
        <Route path="/admin" element={<SignedIn><Admin /></SignedIn>} />
        <Route path="*" element={<SignedIn><Account /></SignedIn>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
