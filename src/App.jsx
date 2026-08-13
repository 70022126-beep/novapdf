import { BrowserRouter, Routes, Route } from "react-router-dom";

import Header from "./components/Header";
import Hero from "./components/Hero";
import Tools from "./components/Tools";

import MergePDF from "./pages/MergePDF/MergePDF";
import SplitPDF from "./pages/SplitPDF/SplitPDF";
import CompressPDF from "./pages/CompressPDF/CompressPDF";
import ConvertPDF from "./pages/ConvertPDF/ConvertPDF";

function Home() {
    return (
        <>
            <Hero />
            <Tools />
        </>
    );
}

function App() {
    return (
        <BrowserRouter>
            <Header />

            <Routes>

                <Route
                    path="/"
                    element={<Home />}
                />

                <Route
                    path="/merge-pdf"
                    element={<MergePDF />}
                />

                <Route
                    path="/split-pdf"
                    element={<SplitPDF />}
                />

                <Route
                    path="/compress-pdf"
                    element={<CompressPDF />}
                />

                <Route
                    path="/convert-pdf"
                    element={<ConvertPDF />}
                />

            </Routes>
        </BrowserRouter>
    );
}

export default App;