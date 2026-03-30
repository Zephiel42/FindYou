import { Routes, Route } from "react-router-dom";

function Home() {
    return (
        <main>
            <h1>FindYou</h1>
        </main>
    );
}

function NotFound() {
    return <h1>404 — Page not found</h1>;
}

export default function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="*" element={<NotFound />} />
        </Routes>
    );
}
