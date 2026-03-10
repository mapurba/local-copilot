import { NgModule, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { FormioModule } from '@iam/angular-formio';

import { App } from './app';
import { ChatComponent } from './components/chat/chat.component';
import { FileTreeComponent } from './components/file-tree/file-tree.component';
import { FileViewerComponent } from './components/file-viewer/file-viewer.component';
import { FormioBuilderViewerComponent } from './components/formio-builder-viewer/formio-builder-viewer.component';
import { MonacoXmlViewerComponent } from './components/monaco-xml-viewer/monaco-xml-viewer.component';
import { WorkflowBuilderViewerComponent } from './components/workflow-builder-viewer/workflow-builder-viewer.component';

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
    RouterModule.forRoot([]),
    MonacoEditorModule.forRoot({
      baseUrl: 'assets/monaco/min/vs',
    }),
    FormioModule,
    WorkflowBuilderViewerComponent,
  ],
  bootstrap: [App],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
