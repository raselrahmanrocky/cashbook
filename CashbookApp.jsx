import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Minus, 
  Printer, 
  Search, 
  Trash2, 
  Save, 
  LayoutDashboard,
  Sparkles,
  Edit,
  X,
  CreditCard,
  Filter,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  History,
  FileText // <-- Added FileText icon import
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken 
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  serverTimestamp,
  updateDoc 
} from 'firebase/firestore';

// --- Firebase Initialization ---
const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// --- Global Constants ---
const ALL_CATEGORIES = ['Sales', 'Purchase', 'Rent', 'Salary', 'Food', 'Transportation', 'Utilities', 'Other'];
const ALL_PAYMENT_MODES = ['Cash', 'bKash', 'Nagad', 'Bank', 'Card'];
const PRINTER_OPTIONS = ['Toshiba 2523AD', 'Epson L3250'];

// --- Gemini API Utility ---

const callGeminiAPI = async (userQuery, systemPrompt, responseSchema) => {
  const apiKey = ""; // Canvas runtime provides this
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: {
        parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: responseSchema
    }
  };

  let lastError = null;
  // Implement exponential backoff for retries
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const result = await response.json();
      const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        return JSON.parse(text);
      }
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed:`, error);
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  console.error("Gemini API failed after all retries.", lastError);
  return null;
};


// --- Helper Components ---

const StatCard = ({ title, amount, type, isCurrency = true }) => {
  let colorClass = "text-gray-800";
  if (type === 'in') colorClass = "text-green-600";
  if (type === 'out') colorClass = "text-red-600";
  if (type === 'balance') colorClass = "text-blue-600";
  if (type === 'pages') colorClass = "text-purple-600"; 
  if (type === 'due') colorClass = "text-yellow-600"; 

  const displayAmount = isCurrency && type === 'due' ? Math.round(amount) : amount;

  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col">
      <span className="text-gray-500 text-sm font-medium uppercase tracking-wide">{title}</span>
      <span className={`text-2xl font-bold mt-1 ${colorClass}`}>
        {isCurrency ? '৳ ' : ''}
        {displayAmount.toLocaleString()}
      </span>
    </div>
  );
};

const PaymentBadge = ({ mode }) => {
  let bgClass = "bg-gray-100 text-gray-700";
  if (mode === 'bKash') bgClass = "bg-pink-100 text-pink-700 border-pink-200";
  if (mode === 'Nagad') bgClass = "bg-orange-100 text-orange-700 border-orange-200";
  if (mode === 'Bank') bgClass = "bg-blue-100 text-blue-700 border-blue-200";
  if (mode === 'Cash') bgClass = "bg-green-100 text-green-700 border-green-200";

  return (
    <span className={`px-2 py-1 rounded-md text-xs font-bold border ${bgClass}`}>
      {mode}
    </span>
  );
};

// --- Main App Component ---

export default function App() {
  const [user, setUser] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isPrintMode, setIsPrintMode] = useState(false);
  
  // Advanced Filter State
  const [filters, setFilters] = useState({
    text: "", 
    type: "all", 
    category: "all", 
    dueStatus: "all", 
    startDate: "", 
    endDate: "",   
  });
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  // Edit State
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  
  // Form State (Removed date and time)
  const [formData, setFormData] = useState({
    type: 'in', // 'in' or 'out'
    amount: '',
    category: 'Sales',
    paymentMode: 'Cash',
    isDue: false, 
    dueAmount: '', 
    contact: '',
    printerName: PRINTER_OPTIONS[0],
    pages: '',
    remark: ''
  });
  const [isGeminiLoading, setIsGeminiLoading] = useState(false);

  // --- Auth & Data Fetching ---

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Auth failed", error);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

    // RULE: Client-side sorting is performed after snapshot
    const q = collection(db, 'artifacts', appId, 'users', user.uid, 'cashbook_entries');
    
    const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // Sort by date and time descending (newest first)
      data.sort((a, b) => {
        // Ensure date and time exist, fallback to creation time if necessary (for robustness)
        const dateA = new Date(`${a.date || '2000-01-01'}T${a.time || '00:00'}`);
        const dateB = new Date(`${b.date || '2000-01-01'}T${b.time || '00:00'}`);
        return dateB - dateA;
      });

      setTransactions(data);
      setLoading(false);
    }, (error) => {
      console.log(`Error fetching data: ${error.message}`);
      console.error("Data fetch error:", error);
      setLoading(false);
    });

    return () => unsubscribeSnapshot();
  }, [user]);

  // --- Handlers ---

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    setFormData(prev => {
        let newState = { ...prev };
        
        if (type === 'checkbox') {
            newState[name] = checked;
            // If marking as NOT due, clear the due amount
            if (name === 'isDue' && !checked) {
                newState.dueAmount = ''; 
            }
        } else {
            newState[name] = value;
        }
        
        return newState;
    });
  };
  
  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };
  
  // Handler to reset all filters
  const handleResetFilters = () => {
    setFilters({
      text: "",
      type: "all",
      category: "all",
      dueStatus: "all",
      startDate: "",
      endDate: "",
    });
    setShowAdvancedFilters(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditingId(null);
    // Reset form to default new entry state (no date/time in form state anymore)
    setFormData({
      type: 'in', 
      amount: '',
      category: 'Sales',
      paymentMode: 'Cash',
      isDue: false,
      dueAmount: '', 
      contact: '',
      printerName: PRINTER_OPTIONS[0],
      pages: '',
      remark: ''
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Check if amount is provided (always required)
    if (!user || !formData.amount) {
        console.log("Amount is required.");
        return;
    }
    // Check if pages are required for Cash In
    if (formData.type === 'in' && !formData.pages) {
        console.log("Pages are required for Cash In.");
        return;
    }
    // Check if dueAmount is required if marked as due
    if (formData.isDue && !formData.dueAmount) {
        console.log("Due Amount is required if marked as due.");
        return;
    }

    try {
      const pagesValue = formData.type === 'in' && formData.pages ? parseInt(formData.pages, 10) : 0;
      const dueAmountValue = formData.isDue && formData.dueAmount ? parseInt(formData.dueAmount, 10) : 0;

      const transactionData = {
          ...formData,
          amount: parseFloat(formData.amount),
          pages: pagesValue, 
          printerName: formData.type === 'out' ? '' : formData.printerName,
          dueAmount: dueAmountValue, 
      };

      if (isEditing && editingId) {
        // UPDATE existing document: Date and Time remain as they were when created
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'cashbook_entries', editingId);
        await updateDoc(docRef, {
            ...transactionData,
            updatedAt: serverTimestamp() 
        });

        // Reset editing state
        handleCancelEdit();
        console.log("Transaction updated successfully.");

      } else {
        // ADD new document: Stamp with current date and time
        const now = new Date();
        const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const currentTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); // HH:MM
        
        const collectionRef = collection(db, 'artifacts', appId, 'users', user.uid, 'cashbook_entries');
        await addDoc(collectionRef, {
          ...transactionData,
          date: currentDate, // Auto-added date
          time: currentTime, // Auto-added time
          createdAt: serverTimestamp()
        });
  
        // Reset form fields for new entry
        setFormData(prev => ({
          ...prev,
          amount: '',
          contact: '',
          remark: '',
          pages: '', 
          isDue: false, 
          dueAmount: '',
        }));
        console.log("Transaction added successfully.");
      }
    } catch (error) {
      console.error(`Error ${isEditing ? 'updating' : 'adding'} document: `, error);
      console.log(`Failed to ${isEditing ? 'update' : 'save'} transaction.`);
    }
  };

  const handleEditClick = (transaction) => {
    setIsEditing(true);
    setEditingId(transaction.id);
    
    // Load only the editable fields into formData
    setFormData({
      type: transaction.type, 
      amount: String(transaction.amount),
      category: transaction.category,
      paymentMode: transaction.paymentMode,
      isDue: !!transaction.isDue, 
      dueAmount: String(parseInt(transaction.dueAmount, 10) || ''), 
      contact: transaction.contact,
      printerName: PRINTER_OPTIONS.includes(transaction.printerName) && transaction.type === 'in' ? transaction.printerName : PRINTER_OPTIONS[0], 
      pages: String(transaction.pages || ''), 
      remark: transaction.remark
    });
  };

  const handleDelete = async (id) => {
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'cashbook_entries', id));
      console.log("Transaction deleted successfully.");
    } catch (error) {
      console.error("Error deleting: ", error);
    }
  };

  const handlePrint = () => {
    setIsPrintMode(true); 
    window.print();
  };
  
  const handleClosePrintView = () => {
    setIsPrintMode(false);
  };

  // --- Gemini Feature: Suggest Category ---
  const handleSuggestCategory = async () => {
    if (!formData.remark && !formData.contact) {
      console.log("Please enter a contact or remark to get suggestions.");
      return;
    }

    setIsGeminiLoading(true);

    const systemPrompt = `You are an AI financial assistant specializing in small business cash flow. Based on the provided transaction details, analyze the context and suggest the most appropriate 'category' from the following list: ${ALL_CATEGORIES.join(', ')} and 'paymentMode' from this list: ${ALL_PAYMENT_MODES.join(', ')}. Assume 'in' transactions are revenue and 'out' transactions are expenses. Output the response strictly as a JSON object.`;
    
    const userQuery = `I have a cashbook entry. Transaction type: ${formData.type}. Contact: ${formData.contact}. Remark: ${formData.remark}. Amount: ${formData.amount || 'N/A'}. Suggest the best category and payment mode.`;

    const responseSchema = {
      type: "OBJECT",
      properties: {
        suggestedCategory: { 
          type: "STRING", 
          description: `One of: ${ALL_CATEGORIES.join(', ')}` 
        },
        suggestedPaymentMode: { 
          type: "STRING", 
          description: `One of: ${ALL_PAYMENT_MODES.join(', ')}` 
        }
      }
    };

    const suggestion = await callGeminiAPI(userQuery, systemPrompt, responseSchema);

    if (suggestion) {
      const { suggestedCategory, suggestedPaymentMode } = suggestion;
      
      // Update form data if the suggestions are valid
      setFormData(prev => ({
        ...prev,
        category: suggestedCategory && ALL_CATEGORIES.includes(suggestedCategory) ? suggestedCategory : prev.category,
        paymentMode: suggestedPaymentMode && ALL_PAYMENT_MODES.includes(suggestedPaymentMode) ? suggestedPaymentMode : prev.paymentMode
      }));
    }
    
    setIsGeminiLoading(false);
  };
  
  // --- Calculations & Filtering ---

  const { totals, filteredTransactions } = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    let totalPages = 0; 
    let toshibaPages = 0; 
    let epsonPages = 0;   
    let totalDue = 0; 
    
    const { text, type, category, dueStatus, startDate, endDate } = filters;
    const lowerText = text.toLowerCase();
    
    // Convert date strings to Date objects for comparison
    const filterStartDate = startDate ? new Date(startDate) : null;
    const filterEndDate = endDate ? new Date(endDate) : null;
    if (filterEndDate) {
        filterEndDate.setDate(filterEndDate.getDate() + 1);
    }
    
    const filtered = transactions.filter(t => {
      // 1. Text Filter (General Search - includes amount, payment mode, due/paid status)
      const textMatch = !text || 
        (t.contact && t.contact.toLowerCase().includes(lowerText)) ||
        (t.remark && t.remark.toLowerCase().includes(lowerText)) ||
        (t.category && t.category.toLowerCase().includes(lowerText)) ||
        (t.printerName && t.printerName.toLowerCase().includes(lowerText)) ||
        String(t.amount).includes(lowerText) || 
        (t.paymentMode && t.paymentMode.toLowerCase().includes(lowerText)) || 
        (t.isDue && lowerText.includes('due')) || 
        (!t.isDue && lowerText.includes('paid')); 

      if (!textMatch) return false;

      // 2. Type Filter ('in' or 'out')
      if (type !== 'all' && t.type !== type) return false;

      // 3. Category Filter
      if (category !== 'all' && t.category !== category) return false;

      // 4. Due Status Filter
      if (dueStatus === 'due' && !t.isDue) return false;
      if (dueStatus === 'paid' && t.isDue) return false;
      
      // 5. Date Range Filter
      // Use the stored date field for filtering
      const transactionDate = t.date ? new Date(t.date) : null; 
      if (!transactionDate) return true; // Include records without a date (shouldn't happen with new entries)
      
      if (filterStartDate && transactionDate < filterStartDate) return false;
      if (filterEndDate && transactionDate >= filterEndDate) return false; 

      return true;
    });

    // Calculate totals based on ALL transactions, not just filtered ones, for accurate dashboard stats
    transactions.forEach(t => {
      if (t.type === 'in') totalIn += t.amount || 0;
      else totalOut += t.amount || 0;
      
      const pages = t.pages || 0;
      totalPages += pages; 
      
      // Sum up the due amount
      if (t.isDue) {
          totalDue += parseInt(t.dueAmount || 0, 10);
      }

      // Check printer name and tally specific pages
      if (t.printerName === 'Toshiba 2523AD') {
          toshibaPages += pages;
      } else if (t.printerName === 'Epson L3250') {
          epsonPages += pages;
      }
    });
    
    const totals = {
      totalIn,
      totalOut,
      balance: totalIn - totalOut,
      totalPages,
      toshibaPages, 
      epsonPages,
      totalDue 
    };

    return { totals, filteredTransactions: filtered };
    
  }, [transactions, filters]);
  
  const { totalIn, totalOut, balance, totalPages, toshibaPages, epsonPages, totalDue } = totals;
  const filteredTxns = filteredTransactions; 

  // --- Print View Render ---
  if (isPrintMode) {
    return (
      <div className="bg-white min-h-screen p-8 text-black font-sans">
        <style>{`
          @media print {
            .no-print {
              display: none !important;
            }
          }
        `}</style>
        
        {/* Manual Close Button - Hidden during print */}
        <div className="no-print mb-6 text-right">
          <button 
            onClick={handleClosePrintView}
            className="flex items-center gap-1 bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors ml-auto"
          >
            <X size={16} />
            Close Print View
          </button>
        </div>

        <div className="text-center mb-6 border-b pb-4">
          <h1 className="text-3xl font-bold uppercase tracking-wider mb-2">CashBook Report</h1>
          <p className="text-sm text-gray-600">Generated on: {new Date().toLocaleString()}</p>
          
          {/* Display active filters in the report header */}
          <p className="text-xs text-gray-500 mt-2">
            {filters.startDate && `From: ${filters.startDate}`}
            {filters.startDate && filters.endDate && ` | `}
            {filters.endDate && `To: ${filters.endDate}`}
            {(filters.type !== 'all' || filters.category !== 'all' || filters.dueStatus !== 'all') && 
             ` | Type: ${filters.type} | Category: ${filters.category} | Status: ${filters.dueStatus}`}
            {filters.text && ` | Search: "${filters.text}"`}
          </p>
          
        </div>

        {/* Summary grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Total Cash In</div>
            <div className="font-bold text-green-600">৳ {totalIn.toLocaleString()}</div>
          </div>
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Total Cash Out</div>
            <div className="font-bold text-red-600">৳ {totalOut.toLocaleString()}</div>
          </div>
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Net Balance</div>
            <div className="font-bold text-blue-600">৳ {balance.toLocaleString()}</div>
          </div>
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Total Due (Credit)</div>
            <div className="font-bold text-yellow-600">৳ {totalDue.toLocaleString()}</div>
          </div>
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Total Pages</div>
            <div className="font-bold text-purple-600">{totalPages.toLocaleString()}</div>
          </div>
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Toshiba Pages</div>
            <div className="font-bold text-purple-600">{toshibaPages.toLocaleString()}</div>
          </div>
          <div className="border p-2 text-center">
            <div className="text-xs text-gray-500">Epson Pages</div>
            <div className="font-bold text-purple-600">{epsonPages.toLocaleString()}</div>
          </div>
        </div>

        <table className="w-full text-xs border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-2 text-left w-24">Date/Time</th>
              <th className="border p-2 text-left w-24">Printer Name</th>
              <th className="border p-2 text-left w-12">Pages</th>
              <th className="border p-2 text-left w-24">Category</th>
              <th className="border p-2 text-left w-16">Status</th>
              <th className="border p-2 text-right w-20">Due Amount</th> 
              <th className="border p-2 text-left">Details</th>
              <th className="border p-2 text-right w-24">Cash In</th>
              <th className="border p-2 text-right w-24">Cash Out</th>
            </tr>
          </thead>
          <tbody>
            {filteredTxns.map((t) => (
              <tr key={t.id} className="border-b">
                <td className="border p-2">
                  {t.date}<br/>{t.time}
                </td>
                <td className="border p-2 font-medium">
                  {t.printerName || '-'} 
                </td>
                <td className="border p-2 text-center">
                  {t.pages || 0}
                </td>
                <td className="border p-2">{t.category}</td>
                <td className="border p-2 text-center">
                  {t.isDue ? (
                    <span className="font-bold text-yellow-700">Due</span>
                  ) : (
                    <span className="text-green-700">Paid</span>
                  )}
                </td>
                <td className="border p-2 text-right font-mono">
                  {t.isDue && t.dueAmount > 0 ? `৳ ${Math.round(t.dueAmount || 0).toLocaleString()}` : '-'} 
                </td>
                <td className="border p-2">
                  <div className="font-semibold">{t.contact || 'N/A'}</div>
                  <div className="text-gray-500">{t.remark}</div>
                </td>
                <td className="border p-2 text-right font-mono">
                  {t.type === 'in' ? `৳ ${t.amount.toLocaleString()}` : '-'}
                </td>
                <td className="border p-2 text-right font-mono">
                  {t.type === 'out' ? `৳ ${t.amount.toLocaleString()}` : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        <div className="mt-8 pt-8 border-t flex justify-between text-xs text-gray-500">
          <span>Authorized Signature</span>
          <span>Printed from Web CashBook</span>
        </div>
      </div>
    );
  }

  // --- Main View Render ---
  return (
    <div className="bg-gray-50 min-h-screen font-sans text-slate-800">
      
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 text-white p-2 rounded-lg">
              <LayoutDashboard size={20} />
            </div>
            <h1 className="text-xl font-bold text-gray-900">Web.CashBook</h1>
          </div>
          <button 
            onClick={handlePrint}
            className="flex items-center gap-2 bg-gray-800 hover:bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <Printer size={16} />
            <span className="hidden sm:inline">Print Report</span>
          </button>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        
        {/* Stats Section */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          
          {/* Row 1: Financial Stats */}
          <StatCard title="Total Cash In (+)" amount={totalIn} type="in" isCurrency={true} />
          <StatCard title="Total Cash Out (-)" amount={totalOut} type="out" isCurrency={true} />
          <StatCard title="Current Balance" amount={balance} type="balance" isCurrency={true} />
          <StatCard title="Total Due/Credit" amount={totalDue} type="due" isCurrency={true} />
          
          {/* Row 2: Printer Stats */}
          <StatCard title="Total Pages Printed" amount={totalPages} type="pages" isCurrency={false} />
          <StatCard title="Toshiba Pages" amount={toshibaPages} type="pages" isCurrency={false} />
          <StatCard title="Epson Pages" amount={epsonPages} type="pages" isCurrency={false} />
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          
          {/* Left Column: Data Entry Form */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 sticky top-24">
              <h2 className="font-semibold text-lg mb-4 flex items-center gap-2 text-gray-800">
                {isEditing ? (
                  <>
                    <Edit size={18} className="text-orange-500" />
                    Edit Entry
                  </>
                ) : (
                  <>
                    <Plus size={18} className="text-blue-600" />
                    New Entry
                  </>
                )}
              </h2>
              
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Transaction Type Toggle */}
                <div className="grid grid-cols-2 gap-2 bg-gray-100 p-1 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({
                        ...prev, 
                        type: 'in',
                        // Set defaults/keep current values for 'in' specific fields
                        printerName: prev.printerName || PRINTER_OPTIONS[0],
                        pages: prev.pages || '',
                    }))}
                    className={`py-2 text-sm font-semibold rounded-md transition-all ${
                      formData.type === 'in' 
                      ? 'bg-green-500 text-white shadow-sm' 
                      : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Cash In (+)
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({
                        ...prev, 
                        type: 'out',
                        // Clear out 'in' specific fields to ensure clean submission
                        pages: '', 
                    }))}
                    className={`py-2 text-sm font-semibold rounded-md transition-all ${
                      formData.type === 'out' 
                      ? 'bg-red-500 text-white shadow-sm' 
                      : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Cash Out (-)
                  </button>
                </div>

                {/* Amount */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Total Transaction Amount (৳) <span className="text-red-500">*</span></label>
                  <input
                    type="number"
                    name="amount"
                    required
                    value={formData.amount}
                    onChange={handleInputChange}
                    placeholder="0.00"
                    className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono text-lg"
                  />
                </div>

                {/* --- Removed Date & Time Input fields here --- */}
                
                {/* Row: Payment Mode & Category (Now grouped) */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Payment Mode</label>
                    <div className="relative">
                      <select
                        name="paymentMode"
                        value={formData.paymentMode}
                        onChange={handleInputChange}
                        className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none appearance-none"
                      >
                        {ALL_PAYMENT_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                    <select
                      name="category"
                      value={formData.category}
                      onChange={handleInputChange}
                      className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                    >
                      {ALL_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </div>
                </div>
                
                {/* Due Option (Credit) */}
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                      <label htmlFor="isDue" className="text-sm font-medium text-yellow-800 flex items-center gap-2 select-none">
                        <CreditCard size={16} className="text-yellow-600"/>
                        Mark as Due (Credit)
                      </label>
                      <input
                        type="checkbox"
                        id="isDue"
                        name="isDue"
                        checked={formData.isDue}
                        onChange={handleInputChange}
                        className="h-5 w-5 rounded text-yellow-600 border-gray-300 focus:ring-yellow-500"
                      />
                    </div>
                    
                    {/* Conditional Due Amount Field */}
                    {formData.isDue && (
                        <div className="space-y-3 p-3 bg-yellow-100 rounded-lg border border-yellow-300">
                            <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">Due Amount (৳) (Integer) <span className="text-red-500">*</span></label>
                                <input
                                    type="number"
                                    name="dueAmount"
                                    required
                                    min="1"
                                    step="1" 
                                    value={formData.dueAmount}
                                    onChange={handleInputChange}
                                    placeholder="Whole amount owed"
                                    className="w-full p-2.5 bg-white border border-yellow-400 rounded-lg focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 outline-none font-mono text-lg"
                                />
                            </div>
                        </div>
                    )}
                </div>


                {/* CONDITIONAL: Printer Name & Pages Fields (Only for Cash In) */}
                {formData.type === 'in' && (
                  <div className="grid grid-cols-2 gap-3">
                    {/* Printer Name Field (SELECT) */}
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Printer Name <span className="text-red-500">*</span></label>
                      <select
                        name="printerName"
                        required={formData.type === 'in'}
                        value={formData.printerName}
                        onChange={handleInputChange}
                        className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                      >
                        {PRINTER_OPTIONS.map(name => <option key={name} value={name}>{name}</option>)}
                      </select>
                    </div>

                    {/* Pages Field (NUMBER) */}
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Pages <span className="text-red-500">*</span></label>
                      <div className="relative">
                        <input
                          type="number"
                          name="pages"
                          required={formData.type === 'in'}
                          min="1"
                          value={formData.pages}
                          onChange={handleInputChange}
                          placeholder="1"
                          className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>
                )}
                {/* END CONDITIONAL */}

                {/* Contact Name */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Contact (Optional)</label>
                  <div className="relative">
                    <input
                      type="text"
                      name="contact"
                      value={formData.contact}
                      onChange={handleInputChange}
                      placeholder="Customer Name"
                      className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                {/* Remarks */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Remark</label>
                  <div className="relative">
                    <input
                      type="text"
                      name="remark"
                      value={formData.remark}
                      onChange={handleInputChange}
                      placeholder="Details about transaction..."
                      className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>
                
                {/* Gemini Suggestion Button */}
                {!isEditing && (
                  <button
                    type="button"
                    onClick={handleSuggestCategory}
                    disabled={isGeminiLoading || (!formData.remark && !formData.contact)}
                    className={`w-full py-3 rounded-lg font-semibold shadow-md transition-all active:scale-95 flex justify-center items-center gap-2 text-sm 
                      ${isGeminiLoading ? 'bg-indigo-300 text-indigo-700 cursor-not-allowed' : 'bg-indigo-100 hover:bg-indigo-200 text-indigo-700'}
                    `}
                  >
                    {isGeminiLoading ? (
                      <>
                        <svg className="animate-spin h-5 w-5 text-indigo-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Suggesting...
                      </>
                    ) : (
                      <>
                        <Sparkles size={18} />
                        Suggest Category & Mode ✨
                      </>
                    )}
                  </button>
                )}


                {/* Save/Update Button */}
                <div className={`grid gap-2 ${isEditing ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  {isEditing && (
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      className="py-3 rounded-lg text-gray-700 font-semibold shadow-md transition-all active:scale-95 flex justify-center items-center gap-2 bg-gray-200 hover:bg-gray-300"
                    >
                      <X size={18} />
                      Cancel
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={isGeminiLoading}
                    className={`py-3 rounded-lg text-white font-semibold shadow-md transition-all active:scale-95 flex justify-center items-center gap-2 ${
                      isEditing ? 'bg-orange-500 hover:bg-orange-600' : 
                      (formData.type === 'in' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700')
                    }`}
                  >
                    <Save size={18} />
                    {isEditing ? 'Update Entry' : 'Save Entry'}
                  </button>
                </div>

              </form>
            </div>
          </div>

          {/* Right Column: Transaction List */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col h-full min-h-[500px]">
              
              {/* List Header & Search/Filter Controls */}
              <div className="p-4 border-b">
                <h2 className="font-semibold text-lg flex items-center gap-2 mb-4">
                  <History size={18} className="text-gray-600" />
                  Transactions
                </h2>
                
                {/* Search Input & Filter Toggle/Reset */}
                <div className="flex gap-2 mb-3">
                    <div className="relative flex-grow">
                      <Search size={16} className="absolute left-3 top-3 text-gray-400" />
                      <input 
                        type="text" 
                        placeholder="Search contact, remark, amount, payment mode, due..." 
                        name="text"
                        value={filters.text}
                        onChange={handleFilterChange}
                        className="w-full pl-9 p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    {/* Reset Filters Button */}
                    <button
                        type="button"
                        onClick={handleResetFilters}
                        className="p-2 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
                        title="Reset All Filters"
                    >
                        <RotateCcw size={18} />
                        <span className="hidden sm:inline">Reset</span>
                    </button>
                    {/* Filter Toggle Button */}
                    <button
                        type="button"
                        onClick={() => setShowAdvancedFilters(prev => !prev)}
                        className={`p-2 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium ${
                            showAdvancedFilters ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                        title="Toggle Advanced Filters"
                    >
                        <Filter size={18} />
                        <span className="hidden sm:inline">Filter</span>
                        {showAdvancedFilters ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                </div>

                {/* Advanced Filters Section (Collapsible) */}
                {showAdvancedFilters && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 pt-3 border-t">
                        
                        {/* Start Date Filter */}
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Start Date</label>
                            <input
                                type="date"
                                name="startDate"
                                value={filters.startDate}
                                onChange={handleFilterChange}
                                className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                            />
                        </div>

                        {/* End Date Filter */}
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">End Date</label>
                            <input
                                type="date"
                                name="endDate"
                                value={filters.endDate}
                                onChange={handleFilterChange}
                                className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                            />
                        </div>

                        {/* Transaction Type Filter */}
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                            <select
                                name="type"
                                value={filters.type}
                                onChange={handleFilterChange}
                                className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                            >
                                <option value="all">All Types</option>
                                <option value="in">Cash In</option>
                                <option value="out">Cash Out</option>
                            </select>
                        </div>

                        {/* Category Filter */}
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                            <select
                                name="category"
                                value={filters.category}
                                onChange={handleFilterChange}
                                className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                            >
                                <option value="all">All Categories</option>
                                {ALL_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                            </select>
                        </div>
                        
                        {/* Due Status Filter */}
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Due Status</label>
                            <select
                                name="dueStatus"
                                value={filters.dueStatus}
                                onChange={handleFilterChange}
                                className="w-full p-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                            >
                                <option value="all">All Statuses</option>
                                <option value="due">Only Due</option>
                                <option value="paid">Only Paid</option>
                            </select>
                        </div>
                    </div>
                )}
              </div>

              {/* List Content */}
              <div className="flex-1 overflow-auto p-2">
                {loading ? (
                  <div className="flex justify-center items-center h-40 text-gray-400">Loading records...</div>
                ) : filteredTxns.length === 0 ? (
                  <div className="flex flex-col justify-center items-center h-40 text-gray-400 text-sm">
                    {/* Fixed: Used the imported FileText component */}
                    <FileText size={32} className="mb-2 opacity-50" />
                    No transactions found matching the current filters.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredTxns.map((t) => (
                      <div key={t.id} className="group bg-white border border-gray-100 rounded-lg p-3 hover:shadow-md transition-shadow flex justify-between items-start">
                        
                        {/* Left Info */}
                        <div className="flex gap-3">
                          <div className={`mt-1 w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                            t.type === 'in' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'
                          }`}>
                            {t.type === 'in' ? <Plus size={20} /> : <Minus size={20} />}
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-semibold text-gray-800">{t.contact || 'No Name'}</span>
                              <span className="text-xs text-gray-400">•</span>
                              <span className="text-xs text-gray-500">{t.date} at {t.time}</span>
                            </div>
                            <div className="flex flex-wrap gap-2 text-xs mb-1">
                              <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600">{t.category}</span>
                              <PaymentBadge mode={t.paymentMode} />
                              {t.isDue && ( 
                                <span className="px-2 py-1 rounded-md text-xs font-bold border bg-yellow-100 text-yellow-700 border-yellow-200">
                                  DUE ৳{Math.round(t.dueAmount || 0).toLocaleString()} 
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-gray-500">{t.remark}</p>
                            {/* Only show printer info if pages are greater than 0 */}
                            {t.pages > 0 && (
                                <div className="text-[10px] text-gray-400 mt-1 flex items-center gap-1">
                                    <Printer size={10} />
                                    {t.printerName || 'N/A'} (Pages: {t.pages})
                                </div>
                            )}
                          </div>
                        </div>

                        {/* Right Info & Actions */}
                        <div className="flex flex-col items-end gap-2">
                          <span className={`font-bold font-mono text-lg ${
                            t.type === 'in' ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {t.type === 'in' ? '+' : '-'} ৳{t.amount.toLocaleString()}
                          </span>
                          <div className="flex gap-2">
                             <button 
                              onClick={() => handleEditClick(t)}
                              className="text-gray-300 hover:text-blue-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Edit Transaction"
                            >
                              <Edit size={16} />
                            </button>
                            <button 
                              onClick={() => handleDelete(t.id)}
                              className="text-gray-300 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Delete Transaction"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>

                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}