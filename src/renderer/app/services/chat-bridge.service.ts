import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

export interface OutgoingAssistantMessage {
  content: string;
}

@Injectable({ providedIn: 'root' })
export class ChatBridgeService {
  private assistantSubject = new Subject<OutgoingAssistantMessage>();
  private userSubject = new Subject<{ content: string }>();

  get assistantMessages$(): Observable<OutgoingAssistantMessage> {
    return this.assistantSubject.asObservable();
  }

  get userMessages$(): Observable<{ content: string }> {
    return this.userSubject.asObservable();
  }

  sendAssistantMessage(content: string) {
    this.assistantSubject.next({ content });
  }

  sendUserMessage(content: string) {
    this.userSubject.next({ content });
  }
}
