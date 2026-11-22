import { createRoot } from 'react-dom/client';
import { installKeyedFetch, ready } from './key';
import { App } from './App';
import './styles.css';

installKeyedFetch();
// the window first trades its one-time link for the access cookie, then the studio starts
void ready.then(() => createRoot(document.getElementById('root')!).render(<App />));
