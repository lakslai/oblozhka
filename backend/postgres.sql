-- Run in a transaction on a server-owned connection. The Node adapter applies version 1 at startup.
CREATE SCHEMA IF NOT EXISTS oblozhka;
REVOKE ALL ON SCHEMA oblozhka FROM PUBLIC;
SET LOCAL search_path TO oblozhka, pg_catalog;

CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, password text, identity text UNIQUE,
 credits integer NOT NULL DEFAULT 3 CHECK (credits>=0), prefs text NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
 hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires integer NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS oauth_states (key text PRIMARY KEY,record text NOT NULL,expires integer NOT NULL);
CREATE TABLE IF NOT EXISTS rate_windows (key text PRIMARY KEY,hits integer NOT NULL DEFAULT 1,expires integer NOT NULL);
CREATE TABLE IF NOT EXISTS generations (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), request_key text NOT NULL,
 status text NOT NULL,created integer NOT NULL,UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS projects (
 id text PRIMARY KEY REFERENCES generations(id),user_id text NOT NULL REFERENCES users(id),
 name text NOT NULL,input text NOT NULL,pack text NOT NULL,updated integer NOT NULL,revision integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS project_history ON projects(user_id,updated DESC);
CREATE TABLE IF NOT EXISTS billing_orders (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),request_key text NOT NULL,
 plan text NOT NULL CHECK(plan IN ('pack','pro')),term text NOT NULL CHECK(term IN ('once','month','year')),
 amount integer NOT NULL CHECK(amount>0),promo text NOT NULL,created integer NOT NULL,UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS transactions (
 id text PRIMARY KEY,order_id text NOT NULL UNIQUE REFERENCES billing_orders(id),
 user_id text NOT NULL REFERENCES users(id),amount integer NOT NULL,units integer NOT NULL,
 provider text NOT NULL DEFAULT 'sandbox' CHECK(provider='sandbox'),created integer NOT NULL,paid_end integer
);
CREATE INDEX IF NOT EXISTS billing_history ON transactions(user_id,created DESC);
CREATE TABLE IF NOT EXISTS subscriptions (
 user_id text PRIMARY KEY REFERENCES users(id),order_id text NOT NULL REFERENCES billing_orders(id),
 term text NOT NULL,paid_start integer NOT NULL,paid_end integer NOT NULL,
 period_start integer NOT NULL,remaining integer NOT NULL CHECK(remaining BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS billing_requests (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),request_key text NOT NULL,kind text NOT NULL,
 details text NOT NULL,created integer NOT NULL,UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS admin_notifications (
 id text PRIMARY KEY,request_id text NOT NULL UNIQUE REFERENCES billing_requests(id),created integer NOT NULL,
 delivered integer,attempts integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION credit_payment() RETURNS trigger LANGUAGE plpgsql SET search_path=oblozhka,pg_catalog AS $body$
DECLARE
  purchased billing_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT purchased FROM billing_orders WHERE id=NEW.order_id AND user_id=NEW.user_id;
  IF purchased.amount<>NEW.amount THEN RAISE EXCEPTION 'mismatched_order_amount'; END IF;
  IF purchased.plan='pack' THEN
    UPDATE users SET credits=credits+20 WHERE id=NEW.user_id;
  ELSE
    PERFORM id FROM users WHERE id=NEW.user_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM subscriptions WHERE user_id=NEW.user_id AND paid_end>NEW.created) THEN
      RAISE EXCEPTION 'active_subscription';
    END IF;
    INSERT INTO subscriptions(user_id,order_id,term,paid_start,paid_end,period_start,remaining)
      VALUES(NEW.user_id,purchased.id,purchased.term,NEW.created,NEW.paid_end,NEW.created,100)
      ON CONFLICT(user_id) DO UPDATE SET order_id=excluded.order_id,term=excluded.term,
        paid_start=excluded.paid_start,paid_end=excluded.paid_end,period_start=excluded.period_start,remaining=excluded.remaining;
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER paid_order AFTER INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION credit_payment();

CREATE OR REPLACE FUNCTION apply_monthly_quota() RETURNS trigger LANGUAGE plpgsql SET search_path=oblozhka,pg_catalog AS $body$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE users SET credits=credits+NEW.remaining WHERE id=NEW.user_id;
  ELSIF NEW.period_start<>OLD.period_start OR NEW.order_id<>OLD.order_id THEN
    UPDATE users SET credits=credits-OLD.remaining+NEW.remaining WHERE id=NEW.user_id;
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER monthly_quota AFTER INSERT OR UPDATE OF period_start,order_id ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION apply_monthly_quota();

CREATE OR REPLACE FUNCTION spend_subscription_unit() RETURNS trigger LANGUAGE plpgsql SET search_path=oblozhka,pg_catalog AS $body$
BEGIN
  IF NEW.credits=OLD.credits-1 THEN
    UPDATE subscriptions SET remaining=remaining-1 WHERE user_id=NEW.id AND remaining>0 AND paid_end>extract(epoch from clock_timestamp());
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER plan_first AFTER UPDATE OF credits ON users FOR EACH ROW EXECUTE FUNCTION spend_subscription_unit();

CREATE OR REPLACE FUNCTION queue_admin_notification() RETURNS trigger LANGUAGE plpgsql SET search_path=oblozhka,pg_catalog AS $body$
BEGIN
  INSERT INTO admin_notifications(id,request_id,created) VALUES(NEW.id,NEW.id,NEW.created);
  RETURN NEW;
END;
$body$;
CREATE TRIGGER queue_request AFTER INSERT ON billing_requests FOR EACH ROW EXECUTE FUNCTION queue_admin_notification();
