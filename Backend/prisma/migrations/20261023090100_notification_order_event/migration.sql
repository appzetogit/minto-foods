-- Order pushes to customers are kept in their in-app inbox.
ALTER TYPE "NotificationSource" ADD VALUE IF NOT EXISTS 'ORDER_EVENT';
