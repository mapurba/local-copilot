import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

export interface OutgoingAssistantMessage {
  content: string;
}

export interface PrdArtifactsSavedEvent {
  outputDir?: string;
  files?: string[];
}

export interface PrdTodoItem {
  id: number;
  title: string;
  details?: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

@Injectable({ providedIn: 'root' })
export class ChatBridgeService {
  private assistantSubject = new Subject<OutgoingAssistantMessage>();
  private userSubject = new Subject<{ content: string }>();
  private prdArtifactsSavedSubject = new Subject<PrdArtifactsSavedEvent>();
  private prdTodoSubject = new Subject<PrdTodoItem[]>();

  get assistantMessages$(): Observable<OutgoingAssistantMessage> {
    return this.assistantSubject.asObservable();
  }

  get userMessages$(): Observable<{ content: string }> {
    return this.userSubject.asObservable();
  }

  get prdArtifactsSaved$(): Observable<PrdArtifactsSavedEvent> {
    return this.prdArtifactsSavedSubject.asObservable();
  }

  get prdTodo$(): Observable<PrdTodoItem[]> {
    return this.prdTodoSubject.asObservable();
  }

  sendAssistantMessage(content: string) {
    this.assistantSubject.next({ content });
  }

  sendUserMessage(content: string) {
    this.userSubject.next({ content });
  }

  sendPrdArtifactsSaved(event: PrdArtifactsSavedEvent) {
    this.prdArtifactsSavedSubject.next(event);
  }

  sendPrdTodo(items: PrdTodoItem[]) {
    this.prdTodoSubject.next(items);
  }
}
