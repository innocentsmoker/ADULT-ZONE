const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
  fs.mkdirSync('./uploads/avatars');
  fs.mkdirSync('./uploads/content');
}

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/privatezone', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected')).catch(err => console.log(err));

// ==================== MODELS ====================

// User Model
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'creator', 'admin'], default: 'user' },
  ageVerified: { type: Boolean, default: false },
  dateOfBirth: { type: Date, required: true },
  walletBalance: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

const User = mongoose.model('User', userSchema);

// Creator Model
const creatorSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bio: String,
  avatar: String,
  subscriptionPrice: { type: Number, default: 9.99 },
  isVerified: { type: Boolean, default: false },
  verificationDocs: { idCard: String, selfie: String },
  totalEarnings: { type: Number, default: 0 },
  totalSubscribers: { type: Number, default: 0 },
  rating: { type: Number, default: 0 },
  category: { type: String, enum: ['adult', 'fitness', 'art', 'music', 'other'], default: 'other' },
  createdAt: { type: Date, default: Date.now }
});

const Creator = mongoose.model('Creator', creatorSchema);

// Content Model
const contentSchema = new mongoose.Schema({
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Creator', required: true },
  title: { type: String, required: true },
  description: String,
  type: { type: String, enum: ['image', 'video'], required: true },
  fileUrl: { type: String, required: true },
  thumbnailUrl: String,
  price: { type: Number, default: 0 },
  isPayPerView: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
  views: { type: Number, default: 0 },
  flagged: { type: Boolean, default: false },
  flagReasons: [String],
  createdAt: { type: Date, default: Date.now }
});

const Content = mongoose.model('Content', contentSchema);

// Subscription Model
const subscriptionSchema = new mongoose.Schema({
  subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Creator', required: true },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  amount: { type: Number, required: true },
  autoRenew: { type: Boolean, default: false }
});

const Subscription = mongoose.model('Subscription', subscriptionSchema);

// Transaction Model
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['deposit', 'subscription', 'payperview', 'withdrawal'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  paymentMethod: { type: String, enum: ['mpesa', 'wallet'], default: 'wallet' },
  mpesaCode: String,
  description: String,
  reference: String,
  createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

// Report Model
const reportSchema = new mongoose.Schema({
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentType: { type: String, enum: ['user', 'creator', 'content'], required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  reason: { type: String, required: true },
  status: { type: String, enum: ['pending', 'reviewed', 'actioned'], default: 'pending' },
  adminNotes: String,
  createdAt: { type: Date, default: Date.now }
});

const Report = mongoose.model('Report', reportSchema);

// ==================== MIDDLEWARE ====================

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, 'secretkey123');
    const user = await User.findById(decoded.id);
    if (!user) throw new Error();
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const adminOnly = async (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

const creatorOnly = async (req, res, next) => {
  if (req.user.role !== 'creator' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Creator only' });
  }
  next();
};

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.url.includes('avatar') ? 'avatars' : 'content';
    cb(null, `uploads/${type}`);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/mpeg'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ==================== AUTH ROUTES ====================

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, dateOfBirth, role } = req.body;
    
    const age = Math.floor((new Date() - new Date(dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) return res.status(403).json({ error: 'Must be 18+' });
    
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(400).json({ error: 'User exists' });
    
    const user = new User({ username, email, password, dateOfBirth, ageVerified: true, role: role || 'user' });
    await user.save();
    
    if (role === 'creator') {
      const creator = new Creator({ userId: user._id });
      await creator.save();
    }
    
    const token = jwt.sign({ id: user._id }, 'secretkey123', { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, username, email, role: user.role, walletBalance: user.walletBalance } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user._id }, 'secretkey123', { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, username: user.username, email, role: user.role, walletBalance: user.walletBalance } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CREATOR ROUTES ====================

app.get('/api/creators', async (req, res) => {
  try {
    const creators = await Creator.find({ isVerified: true }).populate('userId', 'username email');
    res.json(creators);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/creators/:id', async (req, res) => {
  try {
    const creator = await Creator.findById(req.params.id).populate('userId', 'username email');
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    res.json(creator);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/creators/:id/subscribe', auth, async (req, res) => {
  try {
    const creator = await Creator.findById(req.params.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const existingSub = await Subscription.findOne({ subscriberId: req.user._id, creatorId: creator._id, isActive: true });
    if (existingSub) return res.status(400).json({ error: 'Already subscribed' });
    
    if (req.user.walletBalance < creator.subscriptionPrice) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    req.user.walletBalance -= creator.subscriptionPrice;
    await req.user.save();
    
    creator.totalEarnings += creator.subscriptionPrice;
    creator.totalSubscribers += 1;
    await creator.save();
    
    const subscription = new Subscription({
      subscriberId: req.user._id,
      creatorId: creator._id,
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: creator.subscriptionPrice
    });
    await subscription.save();
    
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'subscription',
      amount: creator.subscriptionPrice,
      status: 'completed',
      description: `Subscription to ${creator.userId?.username || 'creator'}`
    });
    await transaction.save();
    
    res.json({ message: 'Subscribed successfully', balance: req.user.walletBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/creators/:id/content', auth, async (req, res) => {
  try {
    const creator = await Creator.findById(req.params.id);
    const hasSubscription = await Subscription.findOne({ subscriberId: req.user._id, creatorId: creator._id, isActive: true });
    
    let content = await Content.find({ creatorId: creator._id, isApproved: true });
    
    if (!hasSubscription && req.user.role !== 'admin') {
      content = content.filter(c => !c.isPayPerView || c.price === 0);
    }
    
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/content/:id/unlock', auth, async (req, res) => {
  try {
    const content = await Content.findById(req.params.id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    
    if (req.user.walletBalance < content.price) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    req.user.walletBalance -= content.price;
    await req.user.save();
    
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'payperview',
      amount: content.price,
      status: 'completed',
      description: `Pay-per-view: ${content.title}`
    });
    await transaction.save();
    
    res.json({ message: 'Content unlocked', balance: req.user.walletBalance, contentUrl: content.fileUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== UPLOAD ROUTES ====================

app.post('/api/upload/content', auth, creatorOnly, upload.single('file'), async (req, res) => {
  try {
    const { title, description, type, price, isPayPerView } = req.body;
    const creator = await Creator.findOne({ userId: req.user._id });
    
    if (!creator) return res.status(404).json({ error: 'Creator profile not found' });
    
    const content = new Content({
      creatorId: creator._id,
      title,
      description,
      type,
      fileUrl: `/uploads/content/${req.file.filename}`,
      price: parseFloat(price) || 0,
      isPayPerView: isPayPerView === 'true',
      isApproved: false
    });
    
    await content.save();
    res.json({ message: 'Content uploaded successfully', content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== WALLET & PAYMENTS ====================

app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const { amount, phoneNumber } = req.body;
    
    if (amount < 10) return res.status(400).json({ error: 'Minimum deposit is 10 KES' });
    
    // Simulate M-Pesa payment
    const transactionId = `MPESA${Date.now()}${Math.floor(Math.random() * 1000)}`;
    
    req.user.walletBalance += amount;
    await req.user.save();
    
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'deposit',
      amount,
      status: 'completed',
      paymentMethod: 'mpesa',
      mpesaCode: transactionId,
      description: `Deposit of ${amount} KES via M-Pesa`
    });
    await transaction.save();
    
    res.json({ message: 'Deposit successful', balance: req.user.walletBalance, transactionId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wallet/balance', auth, async (req, res) => {
  res.json({ balance: req.user.walletBalance });
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  const transactions = await Transaction.find({ userId: req.user._id }).sort('-createdAt').limit(50);
  res.json(transactions);
});

// ==================== CREATOR DASHBOARD ====================

app.get('/api/creator/stats', auth, creatorOnly, async (req, res) => {
  try {
    const creator = await Creator.findOne({ userId: req.user._id });
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const content = await Content.find({ creatorId: creator._id });
    const subscribers = await Subscription.find({ creatorId: creator._id, isActive: true });
    
    res.json({
      creator,
      totalContent: content.length,
      totalSubscribers: subscribers.length,
      totalEarnings: creator.totalEarnings,
      monthlyViews: content.reduce((sum, c) => sum + c.views, 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/creator/content', auth, creatorOnly, async (req, res) => {
  try {
    const creator = await Creator.findOne({ userId: req.user._id });
    const content = await Content.find({ creatorId: creator._id }).sort('-createdAt');
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/users/:id/status', auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.isActive = req.body.isActive;
    await user.save();
    res.json({ message: 'User status updated', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/content/pending', auth, adminOnly, async (req, res) => {
  const content = await Content.find({ isApproved: false }).populate('creatorId');
  res.json(content);
});

app.put('/api/admin/content/:id/approve', auth, adminOnly, async (req, res) => {
  const content = await Content.findById(req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  content.isApproved = true;
  await content.save();
  res.json({ message: 'Content approved' });
});

app.post('/api/admin/report', auth, async (req, res) => {
  try {
    const { contentType, contentId, reason } = req.body;
    const report = new Report({
      reportedBy: req.user._id,
      contentType,
      contentId,
      reason
    });
    await report.save();
    res.json({ message: 'Report submitted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/reports', auth, adminOnly, async (req, res) => {
  const reports = await Report.find().populate('reportedBy', 'username');
  res.json(reports);
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  const totalUsers = await User.countDocuments();
  const totalCreators = await Creator.countDocuments();
  const totalContent = await Content.countDocuments();
  const totalRevenue = await Transaction.aggregate([{ $match: { type: 'subscription' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  
  res.json({
    totalUsers,
    totalCreators,
    totalContent,
    totalRevenue: totalRevenue[0]?.total || 0
  });
});

// ==================== CREATE ADMIN USER ====================

const createAdmin = async () => {
  const adminExists = await User.findOne({ email: 'admin@privatezone.com' });
  if (!adminExists) {
    const admin = new User({
      username: 'admin',
      email: 'admin@privatezone.com',
      password: 'Admin123!',
      dateOfBirth: new Date('1990-01-01'),
      ageVerified: true,
      role: 'admin'
    });
    await admin.save();
    console.log('Admin user created: admin@privatezone.com / Admin123!');
  }
};

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  await createAdmin();
  console.log(`Server running on http://localhost:${PORT}`);
});
