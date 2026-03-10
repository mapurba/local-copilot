import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimations(),
    // provideHttpClient(),
    provideRouter([]),
    importProvidersFrom(MonacoEditorModule.forRoot({
      baseUrl: 'assets/monaco/min/vs',
    }))
  ]
};
