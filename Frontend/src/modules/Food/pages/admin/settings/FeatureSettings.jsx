import React, { useEffect, useMemo, useState } from 'react';
import { adminAPI } from '@/services/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@food/components/ui/card';
import { Button } from '@food/components/ui/button';
import { Switch } from '@food/components/ui/switch';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

const FEATURE_KEYS = {
    RESTAURANT_SUBSCRIPTION: 'restaurant_subscription',
    ADMIN_ACCESS_SECTION: 'admin_access_section',
    ROOT_LANDING_AND_UNREGISTERED_CONTROL: 'root_landing_and_unregistered_control',
    RESTAURANT_SELF_ONBOARDING: 'restaurant_self_onboarding',
    DELIVERY_SELF_ONBOARDING: 'delivery_self_onboarding'
};

/** Self sign-up switches: what turning each one off means, for the confirm box. */
const ONBOARDING_SWITCHES = [
    {
        key: FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING,
        title: 'Restaurant Self-Onboarding',
        description: 'Whether new restaurants can sign up themselves from the restaurant app or website.',
        on: 'On: a new number can verify OTP and fill the registration form',
        off: 'Off: a new number sees "Account not found" — add restaurants from Restaurants → Add Restaurant',
        confirmOff: "New restaurants won't be able to sign up from the app. They'll see \"Account not found\" until you add them from Add Restaurant. Existing restaurants are not affected.",
    },
    {
        key: FEATURE_KEYS.DELIVERY_SELF_ONBOARDING,
        title: 'Delivery Partner Self-Onboarding',
        description: 'Whether new riders can sign up themselves from the delivery app.',
        on: 'On: a new number can verify OTP and fill the registration form',
        off: 'Off: a new number sees "Account not found" — add riders from Deliveryman → Add Deliveryman',
        confirmOff: "New riders won't be able to sign up from the app. They'll see \"Account not found\" until you add them from Add Deliveryman. Existing riders are not affected.",
    },
];

export default function FeatureSettings() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [features, setFeatures] = useState([]);
    // As last saved, so switching sign-up OFF can be confirmed once, on save.
    const [savedFeatures, setSavedFeatures] = useState([]);

    const restaurantSubscription = useMemo(
        () => features.find((item) => item.key === FEATURE_KEYS.RESTAURANT_SUBSCRIPTION) || null,
        [features]
    );

    const adminAccessSection = useMemo(
        () => features.find((item) => item.key === FEATURE_KEYS.ADMIN_ACCESS_SECTION) || null,
        [features]
    );

    const rootLandingAndUnregisteredControl = useMemo(
        () => features.find((item) => item.key === FEATURE_KEYS.ROOT_LANDING_AND_UNREGISTERED_CONTROL) || null,
        [features]
    );

    useEffect(() => {
        const load = async () => {
            try {
                setLoading(true);
                const res = await adminAPI.getFeatureSettings();
                const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
                setFeatures(rows);
                setSavedFeatures(rows);
            } catch (error) {
                toast.error('Failed to load feature settings.');
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);

    const setToggle = (key, checked) => {
        setFeatures((prev) =>
            prev.map((row) =>
                row.key === key ? { ...row, isEnabled: Boolean(checked) } : row
            )
        );
    };

    const handleSave = async () => {
        const onboarding = ONBOARDING_SWITCHES.map((sw) => features.find((f) => f.key === sw.key)).filter(Boolean);
        const updates = [restaurantSubscription, adminAccessSection, rootLandingAndUnregisteredControl, ...onboarding].filter(Boolean);
        if (updates.length === 0) return;
        const closing = ONBOARDING_SWITCHES.filter((sw) => {
            const now = features.find((f) => f.key === sw.key);
            const before = savedFeatures.find((f) => f.key === sw.key);
            return now && !now.isEnabled && before?.isEnabled !== false;
        });
        if (closing.length && !window.confirm(closing.map((sw) => sw.confirmOff).join('\n\n') + '\n\nSave?')) return;
        try {
            setSaving(true);
            await Promise.all(
                updates.map((feature) =>
                    adminAPI.updateFeatureSetting(feature.key, {
                        isEnabled: Boolean(feature.isEnabled)
                    })
                )
            );
            updates.forEach((feature) => {
                window.dispatchEvent(new CustomEvent('adminFeatureSettingUpdated', {
                    detail: {
                        key: feature.key,
                        isEnabled: Boolean(feature.isEnabled)
                    }
                }));
            });
            setSavedFeatures(features);
            toast.success('Feature setting updated successfully.');
        } catch (error) {
            toast.error(error?.response?.data?.message || 'Failed to update feature setting.');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex h-[320px] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-gray-900">Feature Settings</h1>
                <p className="text-sm text-gray-500 mt-1">Enable or disable platform features safely from one place.</p>
            </div>

            <Card className="border-slate-200">
                <CardHeader>
                    <CardTitle className="text-lg">Restaurant Subscription</CardTitle>
                    <CardDescription>
                        Controls post-approval onboarding payment, due checks, withdrawal restrictions, and subscription settings visibility.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-4">
                    <div className="text-sm text-gray-700">
                        {restaurantSubscription?.isEnabled
                            ? 'Enabled: subscription flows are active'
                            : 'Disabled: subscription flows are hidden and checks are bypassed'}
                    </div>
                    <Switch
                        checked={Boolean(restaurantSubscription?.isEnabled)}
                        onCheckedChange={(checked) => setToggle(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, checked)}
                    />
                </CardContent>
            </Card>

            <Card className="border-slate-200">
                <CardHeader>
                    <CardTitle className="text-lg">Admin Access Section</CardTitle>
                    <CardDescription>
                        Controls visibility of the Admin Access sidebar section, including Sub Admin List.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-4">
                    <div className="text-sm text-gray-700">
                        {adminAccessSection?.isEnabled
                            ? 'Enabled: Admin Access section is visible'
                            : 'Disabled: Admin Access section is hidden'}
                    </div>
                    <Switch
                        checked={Boolean(adminAccessSection?.isEnabled)}
                        onCheckedChange={(checked) => setToggle(FEATURE_KEYS.ADMIN_ACCESS_SECTION, checked)}
                    />
                </CardContent>
            </Card>

            <Card className="border-slate-200">
                <CardHeader>
                    <CardTitle className="text-lg">Root Landing & Unregistered Restaurants</CardTitle>
                    <CardDescription>
                        Controls root URL and Unregistered Restaurants visibility. OFF redirects root (/) to /food/user and hides Unregistered Restaurants.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-4">
                    <div className="text-sm text-gray-700">
                        {rootLandingAndUnregisteredControl?.isEnabled
                            ? 'Enabled: root opens Landing Page and Unregistered Restaurants is visible'
                            : 'Disabled: root redirects to /food/user and Unregistered Restaurants is hidden'}
                    </div>
                    <Switch
                        checked={Boolean(rootLandingAndUnregisteredControl?.isEnabled)}
                        onCheckedChange={(checked) => setToggle(FEATURE_KEYS.ROOT_LANDING_AND_UNREGISTERED_CONTROL, checked)}
                    />
                </CardContent>
            </Card>

            {ONBOARDING_SWITCHES.map((sw) => {
                const row = features.find((f) => f.key === sw.key);
                if (!row) return null;
                return (
                    <Card key={sw.key} className="border-slate-200">
                        <CardHeader>
                            <CardTitle className="text-lg">{sw.title}</CardTitle>
                            <CardDescription>{sw.description}</CardDescription>
                        </CardHeader>
                        <CardContent className="flex items-center justify-between gap-4">
                            <div className={`text-sm ${row.isEnabled ? 'text-gray-700' : 'text-amber-700'}`}>
                                {row.isEnabled ? sw.on : sw.off}
                            </div>
                            <Switch
                                checked={Boolean(row.isEnabled)}
                                onCheckedChange={(checked) => setToggle(sw.key, checked)}
                            />
                        </CardContent>
                    </Card>
                );
            })}

            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving || (!restaurantSubscription && !adminAccessSection && !rootLandingAndUnregisteredControl)}>
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    Save Changes
                </Button>
            </div>
        </div>
    );
}
