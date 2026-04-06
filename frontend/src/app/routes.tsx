import { createHashRouter } from "react-router";
import Dashboard from "./pages/Dashboard";
import DailyLog from "./pages/DailyLog";
import History from "./pages/History";
import Summary from "./pages/Summary";

export const router = createHashRouter([
  {
    path: "/",
    Component: Dashboard,
  },
  {
    path: "/day/:date",
    Component: DailyLog,
  },
  {
    path: "/history",
    Component: History,
  },
  {
    path: "/summary",
    Component: Summary,
  },
]);
