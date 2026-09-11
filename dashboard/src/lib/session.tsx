/**
 * Who is signed in, and what they are looking at.
 *
 * Two pieces of app-wide state, deliberately together: the principal, and the
 * project/environment pair every other screen is scoped to. Everything else is
 * loaded by the screen that needs it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { A, onUnauthorized, type Environment, type Member, type Principal, type Project } from "./api";
import { useStored } from "./hooks";

interface SessionValue {
  status: "loading" | "anonymous" | "signed-in";
  member: Member | null;
  principal: Principal | null;
  /** True when this deployment has no accounts at all yet. */
  needsSetup: boolean;

  projects: Project[];
  environments: Environment[];
  project: string;
  environment: string;
  setProject: (key: string) => void;
  setEnvironment: (key: string) => void;
  /** The selected environment's row, for the production warning colours. */
  currentEnvironment: Environment | null;

  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (role: Principal["role"]) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

const RANK: Record<Principal["role"], number> = { reader: 0, writer: 1, admin: 2, owner: 3 };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionValue["status"]>("loading");
  const [member, setMember] = useState<Member | null>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [project, setProject] = useStored("fk.project", "");
  const [environment, setEnvironment] = useStored("fk.environment", "");

  /** Any request finding the session gone drops the whole app to the login page. */
  useEffect(() => onUnauthorized(() => setStatus("anonymous")), []);

  const loadIdentity = useCallback(async () => {
    try {
      const me = await A.me();
      setMember(me.member);
      setPrincipal(me.principal);
      setStatus("signed-in");
    } catch {
      setStatus("anonymous");
      setMember(null);
      setPrincipal(null);
      try {
        // Distinguishes "log in" from "there is nobody to log in as", which is
        // the state of every fresh deployment.
        const { members } = await A.bootstrap();
        setNeedsSetup(members === 0);
      } catch {
        setNeedsSetup(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  /* projects and environments, once signed in */

  useEffect(() => {
    if (status !== "signed-in") return;
    void (async () => {
      const { projects: list } = await A.projects();
      setProjects(list);
      // A stored selection that no longer exists silently becomes the first
      // project, rather than a screen that says "no such project".
      if (list.length > 0 && !list.some((p) => p.key === project)) setProject(list[0]!.key);
    })();
  }, [status, project, setProject]);

  useEffect(() => {
    if (status !== "signed-in" || project === "") return;
    void (async () => {
      try {
        const { environments: list } = await A.environments(project);
        setEnvironments(list);
        if (list.length > 0 && !list.some((e) => e.key === environment)) {
          setEnvironment(list[0]!.key);
        }
      } catch {
        setEnvironments([]);
      }
    })();
  }, [status, project, environment, setEnvironment]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      member,
      principal,
      needsSetup,
      projects,
      environments,
      project,
      environment,
      setProject: (key: string) => {
        setProject(key);
        // The environment belongs to the old project; clearing it lets the
        // effect above pick this project's first one.
        setEnvironment("");
      },
      setEnvironment,
      currentEnvironment: environments.find((e) => e.key === environment) ?? null,
      refresh: loadIdentity,
      signIn: async (email: string, password: string) => {
        const { member: signedIn } = await A.login(email, password);
        setMember(signedIn);
        await loadIdentity();
      },
      signOut: async () => {
        await A.logout().catch(() => undefined);
        setStatus("anonymous");
        setMember(null);
        setPrincipal(null);
      },
      can: (role) => (principal === null ? false : RANK[principal.role] >= RANK[role]),
    }),
    [
      status,
      member,
      principal,
      needsSetup,
      projects,
      environments,
      project,
      environment,
      setProject,
      setEnvironment,
      loadIdentity,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (context === null) throw new Error("useSession outside SessionProvider");
  return context;
}
