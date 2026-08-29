import type { CommunityMessage, DMContact } from "../../lib/api.ts";
import {
  fetchCommunityMessages,
  fetchUserDMMessages,
  markCommunityAsRead,
  markDMAsRead,
  sendCommunityMessage,
  sendUserDMMessage,
} from "../../lib/api.ts";
import type { DMMessage } from "../../types/index.ts";

export type ChatMessage = DMMessage | CommunityMessage;

export interface ConversationPageOptions {
  before?: string;
}

export interface ConversationPage {
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface ConversationSource {
  fetchPage(
    contactId: string,
    options?: ConversationPageOptions,
  ): Promise<ConversationPage>;
  send(contactId: string, text: string): Promise<ChatMessage>;
  markRead(contactId: string): Promise<void>;
}

interface UserConversationOperations {
  fetchMessages: (
    contactId: string,
    options?: ConversationPageOptions,
  ) => Promise<{ messages: DMMessage[]; hasMore: boolean }>;
  sendMessage: (
    contactId: string,
    text: string,
  ) => Promise<{ message: DMMessage }>;
  markRead: (contactId: string) => Promise<void>;
}

interface CommunityConversationOperations {
  fetchMessages: (
    contactId: string,
    options?: ConversationPageOptions,
  ) => Promise<{ messages: CommunityMessage[]; hasMore: boolean }>;
  sendMessage: (contactId: string, text: string) => Promise<CommunityMessage>;
  markRead: (contactId: string) => Promise<void>;
}

interface ConversationSourceDependencies {
  user?: UserConversationOperations;
  community?: CommunityConversationOperations;
}

const defaultUserOperations: UserConversationOperations = {
  fetchMessages: fetchUserDMMessages,
  sendMessage: sendUserDMMessage,
  markRead: markDMAsRead,
};

const defaultCommunityOperations: CommunityConversationOperations = {
  fetchMessages: fetchCommunityMessages,
  sendMessage: sendCommunityMessage,
  markRead: markCommunityAsRead,
};

function createUserConversationSource(
  operations: UserConversationOperations = defaultUserOperations,
): ConversationSource {
  return {
    async fetchPage(contactId, options) {
      const page = await operations.fetchMessages(contactId, options);
      return { messages: page.messages, hasMore: page.hasMore };
    },
    async send(contactId, text) {
      const result = await operations.sendMessage(contactId, text);
      return result.message;
    },
    markRead: (contactId) => operations.markRead(contactId),
  };
}

function createCommunityConversationSource(
  operations: CommunityConversationOperations = defaultCommunityOperations,
): ConversationSource {
  return {
    async fetchPage(contactId, options) {
      const page = await operations.fetchMessages(contactId, options);
      return { messages: page.messages, hasMore: page.hasMore };
    },
    send: (contactId, text) => operations.sendMessage(contactId, text),
    markRead: (contactId) => operations.markRead(contactId),
  };
}

export function createConversationSource(
  contactType: DMContact["type"],
  dependencies: ConversationSourceDependencies = {},
): ConversationSource {
  return contactType === "community"
    ? createCommunityConversationSource(dependencies.community)
    : createUserConversationSource(dependencies.user);
}
