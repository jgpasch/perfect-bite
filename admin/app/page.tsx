import { redirect } from "next/navigation";

// The portal opens on Users.
export default function Home() {
  redirect("/users");
}
