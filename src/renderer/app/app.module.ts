import { NgModule, CUSTOM_ELEMENTS_SCHEMA, SecurityContext } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { MarkdownModule, MERMAID_OPTIONS } from 'ngx-markdown';
import { FormioModule } from '@iam/angular-formio';

import { App } from './app';
import { FileTreeComponent } from './components/file-tree/file-tree.component';
import { FileViewerComponent } from './components/file-viewer/file-viewer.component';
import { FormioBuilderViewerComponent } from './components/formio-builder-viewer/formio-builder-viewer.component';
import { MonacoXmlViewerComponent } from './components/monaco-xml-viewer/monaco-xml-viewer.component';
import { WorkflowBuilderViewerComponent } from './components/workflow-builder-viewer/workflow-builder-viewer.component';
import { ConvertPrdComponent } from './components/convert-prd/convert-prd.component';
import { ChatComponent } from './components/chat/chat.component';
import { DebugPanelComponent } from './components/debug-panel/debug-panel.component';

@NgModule({
  declarations: [
    App,
    ChatComponent,
    FileTreeComponent,
    FileViewerComponent,
    FormioBuilderViewerComponent,
    MonacoXmlViewerComponent,
  ],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    HttpClientModule,
    FormsModule,
    RouterModule.forRoot([
      { path: 'convert', loadComponent: () => import('./components/convert-prd/convert-prd.component').then(m => m.ConvertPrdComponent) },
    ], { useHash: true }),
    MonacoEditorModule.forRoot({
      baseUrl: 'assets/monaco/min/vs',
    }),
    FormioModule,
    MarkdownModule.forRoot({
      sanitize: SecurityContext.NONE,
      mermaidOptions: {
        provide: MERMAID_OPTIONS,
        useValue: { startOnLoad: false, securityLevel: 'loose' },
      },
    }),
    WorkflowBuilderViewerComponent,
    ConvertPrdComponent,
    DebugPanelComponent,
  ],
  bootstrap: [App],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
