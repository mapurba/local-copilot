import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';
import './styles.css';
import mermaid from 'mermaid';
(window as unknown as Record<string, unknown>)['mermaid'] = mermaid;

platformBrowserDynamic()
  .bootstrapModule(AppModule)
  .catch((err: unknown) => console.error(err));

