// ==================== REAL M-PESA INTEGRATION ====================
// Add this at the top of server.js with other imports

const axios = require('axios');
const crypto = require('crypto');

// YOUR SANDBOX CREDENTIALS (Replace with your actual keys)
const MPESA_CONSUMER_KEY = 'YOUR_CONSUMER_KEY_HERE'; // ← PASTE YOUR KEY
const MPESA_CONSUMER_SECRET = 'YOUR_CONSUMER_SECRET_HERE'; // ← PASTE YOUR SECRET
const MPESA_PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const MPESA_SHORTCODE = '174379'; // Sandbox shortcode
const MPESA_ENV = 'sandbox'; // Change to 'live' when going live

// Get OAuth Token from Safaricom
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  
  try {
    const url = MPESA_ENV === 'sandbox' 
      ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    
    const response = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` }
    });
    
    console.log('✅ M-Pesa token obtained');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ M-Pesa token error:', error.response?.data || error.message);
    return null;
  }
}

// Send STK Push to customer's phone
async function stkPush(phoneNumber, amount, accountReference, callbackUrl) {
  const token = await getMpesaToken();
  if (!token) return { success: false, message: 'Failed to authenticate with M-Pesa' };

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

  // Format phone number to 254XXXXXXXXX
  let formattedPhone = phoneNumber.toString().replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '254' + formattedPhone.substring(1);
  } else if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.substring(1);
  }

  const url = MPESA_ENV === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
    : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

  try {
    const response = await axios.post(url, {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl || 'https://yourdomain.com/api/mpesa/callback',
      AccountReference: accountReference,
      TransactionDesc: 'PRIVATE ZONE Wallet Deposit'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ STK Push error:', error.response?.data || error.message);
    return { success: false, message: error.response?.data?.errorMessage || 'Payment request failed' };
  }
}

// Query transaction status
async function queryTransactionStatus(checkoutRequestId) {
  const token = await getMpesaToken();
  if (!token) return null;

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

  const url = MPESA_ENV === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query'
    : 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query';

  try {
    const response = await axios.post(url, {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    return response.data;
  } catch (error) {
    console.error('Query error:', error.response?.data || error.message);
    return null;
  }
}

// Replace the OLD deposit endpoint with this
app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const { amount, phoneNumber } = req.body;
    
    if (amount < 10) {
      return res.status(400).json({ error: 'Minimum deposit is 10 KES' });
    }
    
    if (amount > 150000) {
      return res.status(400).json({ error: 'Maximum deposit is 150,000 KES' });
    }

    // Create pending transaction first
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'deposit',
      amount: amount,
      status: 'pending',
      paymentMethod: 'mpesa',
      description: `M-Pesa deposit of ${amount} KES`
    });
    await transaction.save();

    // Send STK Push to customer's phone
    const accountRef = `PZ-${req.user._id.toString().slice(-6)}-${Date.now().toString().slice(-4)}`;
    const result = await stkPush(phoneNumber, amount, accountRef, `${req.protocol}://${req.get('host')}/api/mpesa/callback`);
    
    if (result.success) {
      // Update transaction with checkout ID
      transaction.mpesaCode = result.data.CheckoutRequestID;
      await transaction.save();
      
      res.json({ 
        message: '💰 STK Push sent! Check your phone for M-Pesa prompt',
        checkoutRequestId: result.data.CheckoutRequestID,
        transactionId: transaction._id,
        status: 'pending'
      });
    } else {
      transaction.status = 'failed';
      await transaction.save();
      res.status(400).json({ error: result.message });
    }
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// M-Pesa Callback URL (M-Pesa will send payment confirmation here)
app.post('/api/mpesa/callback', async (req, res) => {
  console.log('📞 M-Pesa callback received:', JSON.stringify(req.body, null, 2));
  
  try {
    const { Body } = req.body;
    
    if (Body && Body.stkCallback) {
      const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;
      
      // Find the pending transaction
      const transaction = await Transaction.findOne({ mpesaCode: CheckoutRequestID });
      
      if (transaction) {
        if (ResultCode === 0) {
          // Payment successful
          transaction.status = 'completed';
          
          // Extract amount from metadata
          let amount = transaction.amount;
          if (CallbackMetadata && CallbackMetadata.Item) {
            const amountItem = CallbackMetadata.Item.find(item => item.Name === 'Amount');
            if (amountItem) amount = amountItem.Value;
          }
          
          await transaction.save();
          
          // Add money to user's wallet
          const user = await User.findById(transaction.userId);
          if (user) {
            user.walletBalance += amount;
            await user.save();
            console.log(`✅ Added ${amount} KES to user ${user.username}'s wallet`);
          }
        } else {
          // Payment failed
          transaction.status = 'failed';
          transaction.description = ResultDesc;
          await transaction.save();
          console.log(`❌ Payment failed: ${ResultDesc}`);
        }
      }
    }
    
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: 'Failed' });
  }
});

// Check transaction status endpoint
app.get('/api/mpesa/status/:checkoutRequestId', auth, async (req, res) => {
  try {
    const status = await queryTransactionStatus(req.params.checkoutRequestId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
